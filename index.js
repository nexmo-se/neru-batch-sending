const express = require("express");
const csv = require("csv-parser");
const bodyParser = require("body-parser");
const app = express();
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const memoryStorage = multer.memoryStorage();
const upload = multer({ storage: memoryStorage }).single("file");
const csvService = require("./services/csv");
const { neru, Assets, Scheduler, Messages } = require("neru-alpha");
const smsService = require("./services/sms");
const rateLimiterService = require("./services/rateLimiter");
const tps = parseInt(process.env.TPS || "30", 10);
const rateLimitAxios = rateLimiterService.newInstance(tps);
const createCsvWriter = require("csv-writer").createObjectCsvWriter;
const utils = require("./utils");
const dotenv = require("dotenv");
const uuid = require("uuidv4");
dotenv.config();
app.use(cors());

const fs = require("fs");

const csvWriter = createCsvWriter({
  path: "smsresults.csv",
  header: [
    { id: "to", title: "to" },
    { id: "message-id", title: "message-id" },
    { id: "status", title: "status" },
  ],
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
// set view engine to ejs
app.set("view engine", "ejs");

app.get("/_/health", async (req, res) => {
  res.sendStatus(200);
});

const TEMPLATES_TABLENAME = "TEMPLATES";
// neru tablename for processed filenames
const PROCESSEDFILES_TABLENAME = "processedfiles";
// column name of csv file that contains the template ID
const CSV_TEMPLATE_ID_COLUMN_NAME = "ID_SMSTEXT";
// column name of csv file that contains the phone number of the receiver
const CSV_PHONE_NUMBER_COLUMN_NAME = "MOBILTELEFONNUMMER";
// column name of csv file that contains the ID that will be put into account_ref (together with csv filename)
const CSV_ID_COLUMN_NAME = "ID";
// column name of csv file that contains the ID that will be put in the client_ref field
const CSV_CLIENT_REF_COLUMN_NAME = "VERPFLICHTUNGSNUMMER";
// cron job definition, default is every minute '* * * * *'
// for EOS, we could use '0 9-18 * * 1-5' to run: At minute 0 past every hour from 9 through 18 on every day-of-week from Monday through Friday.
// this makes sure that no one gets sendouts at weekends or in the middle of the night adn check for new files hourly within the given times and days
const CRONJOB_DEFINITION = "* * * * *";
// cancel all monitoring schedulers when server crashes or not
const ON_CRASH_CANCEL_MONITOR = false;

// allow to parse json bodies and form data if needed

// TODO: add simple authentication middleware like username/pw with express-session or passport.js for everything

// NERU GLOBAL STATE contains the following:

// Hash Table: TEMPLATES: {[id]: JSON.stringify({
//   id, Ex: 15210001
//   text, Ex: Hallo {{1}}
//   senderIdField, abcefg
//   updatedAt,
// }}

// TEMPLATE VIEWS START
// Get a list of templates as ejs view
app.get("/templates", async (req, res) => {
  const globalState = neru.getGlobalState();
  const templates = await globalState.hgetall(TEMPLATES_TABLENAME);
  let parsedTemplates;
  if (templates) {
    parsedTemplates = Object.keys(templates).map((key) => {
      const data = JSON.parse(templates[key]);
      return { ...data };
    });
    console.log(JSON.stringify(parsedTemplates));
  }
  res.render("templates/index", { templates: parsedTemplates });
});

// Get a form to create a new template
app.get("/templates/new", async (req, res) => {
  res.render("templates/new", {});
});
// TEMPLATE VIEWS END

// TEMPLATE API START
// Get a list of all templates
app.get("/api/templates", async (req, res) => {
  const globalState = neru.getGlobalState();
  const templates = await globalState.hgetall(TEMPLATES_TABLENAME);
  let parsedTemplates;
  if (templates) {
    parsedTemplates = Object.keys(templates).map((key) => {
      const data = JSON.parse(templates[key]);
      return { ...data };
    });
    console.log(JSON.stringify(parsedTemplates));
  }
  res.json(parsedTemplates);
});

// Get a single temaplte by id
app.get("/api/templates/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res
      .status(404)
      .json({ success: false, error: "please provide a valid id" });
  }
  const globalState = neru.getGlobalState();
  const template = await globalState.hget(TEMPLATES_TABLENAME, id);
  const parsedTemplate = await JSON.parse(template);
  res.json(parsedTemplate);
});

// Create a new template and save it on Neru Global State
app.post("/api/templates", async (req, res) => {
  const globalState = neru.getGlobalState();
  const { id, text, senderIdField } = req.body;
  let newTemplate;
  const updatedAt = new Date().toISOString();
  if (id && text && senderIdField) {
    newTemplate = { id, text, senderIdField };
    const created = await globalState.hset(TEMPLATES_TABLENAME, {
      [id]: JSON.stringify({ id, text, senderIdField, updatedAt }),
    });
    res.json({ created, newTemplate });
  } else if (!id && text && senderIdField) {
    let id = uuid();
    newTemplate = { id, text, senderIdField };
    const created = await globalState.hset(TEMPLATES_TABLENAME, {
      [id]: JSON.stringify({
        id,
        text,
        senderIdField,
        updatedAt,
      }),
    });
    res.json({ created, newTemplate });
  } else {
    res.status(500).json({
      success: false,
      error:
        "please provide at least a valid text and senderIdField and also an id in case of updating existing templates.",
    });
  }
});

// Delete a template by ID
app.delete("/api/templates/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res
      .status(404)
      .json({ success: false, error: "please provide a valid id" });
  }
  const globalState = neru.getGlobalState();
  const deleted = await globalState.hdel(TEMPLATES_TABLENAME, id);
  res.json({ success: true, deleted });
});

app.get("/dfiles", async (req, res) => {
  try {
    const session = neru.createSession();
    const assets = new Assets(session);
    const assetlist = await assets.binary("csv/test.csv").execute();
    console.log(assetlist);

    res.send(assetlist);
  } catch (e) {
    console.log(e);
  }
});

app.post("/checkandsend", async (req, res) => {
  console.log("Checking for files and sending if new CSV files exist...");
  const FILENAME = req.body.prefix || "/test.csv";
  const FILETYPES = "send/";
  const PROCESSEDFILES = "processedfiles";
  try {
    // const globalState = neru.getGlobalState();
    const session = neru.createSession();
    const assets = new Assets(session);
    // const messages = new Messages(session);

    // const lastCheck = await globalState.get('lastCsvCheck');

    // get file list from assets api
    const assetlist = await assets.list(FILETYPES, false, 10).execute();
    console.log(assetlist);

    const newCheck = new Date().toISOString();
    // const savedNewCheck = await globalState.set('lastCsvCheck', newCheck);

    let toBeProcessed = [];
    assetlist.res.forEach((file) => {
      if (file && file.name.endsWith(".csv")) {
        toBeProcessed.push("/" + file.name);
      }
      //toBeProcessed.push("/" + file.name);
    });

    let asset;
    let records;
    let responses = [];
    let savedAsProcessedFile;

    toBeProcessed.forEach(async (filename) => {
      // process and send the file
      asset = await assets.get(filename).execute();

      const fileBuffer = Buffer.from(asset.res.content, "base64");
      // console.log('content: ', fileBuffer.toString());
      records = csvService.fromCsvSync(fileBuffer.toString(), {
        columns: true,
        delimiter: ";",
      });
      const secondsTillEndOfDay = utils.secondsTillEndOfDay(new Date());

      //only send if there's enough time till the end of the working day
      if (secondsTillEndOfDay > parseInt((records.length - 1) / 30)) {
        const sendingResults = await sendSms(records);

        // await writeResults(sendingResults);
      }
      // await assets.copy('smsresults.csv', 'csv/');

      // save info that file was processed already
      // savedAsProcessedFile = await globalState.rpush(PROCESSEDFILES, FILENAME);
    });
    res.sendStatus(200);
  } catch (e) {
    console.log("check and send error: ", e.message);
    res.sendStatus(500);
  }
});

app.get("/test", async (req, res) => {
  const results = [];
  fs.createReadStream("test.csv")
    .pipe(csv({ separator: ";" }))
    .on("data", (data) => {
      results.push(data);
    })
    .on("end", async () => {
      const secondsTillEndOfDay = utils.secondsTillEndOfDay(new Date());

      if (secondsTillEndOfDay > parseInt((results.length - 1) / 30)) {
        const sendingResults = await sendSms(results);
        await writeResults(sendingResults);

        res.json(sendingResults);
      }
      // res.sendStatus(200);
    });
});

const writeResults = async (results) => {
  // if (results.length) {
  csvWriter
    .writeRecords(results) // returns a promise
    .then(() => {
      console.log("...Done");
    })
    .catch((e) =>
      console.log(`Something wrong while writting the output csv ${e}`)
    );
  // } else {
  //   console.log('no sending results');
  // }
};

const sendSms = async (records) => {
  let smsSendingResults = [];

  return new Promise(async (res, rej) => {
    for (let i = 0; i < records.length; i++) {
      if (utils.checkSenderIdValid(records[i]["VERPFLICHTUNGSNUMMER"])) {
        try {
          const response = await smsService.sendSms(
            records[i]["VERPFLICHTUNGSNUMMER"],
            records[i]["EOSTEAMRUECKRUFNUMMER"],
            records[i]["ANREDE"],
            process.env.apikey,
            process.env.apiSecret,
            "https://rest.nexmo.com/sms/json",
            "12",
            rateLimitAxios
          );
          const { messages } = response;
          console.log(messages);

          smsSendingResults.push({
            to: messages[0].to,
            "message-id": messages[0]?.["message-id"]
              ? messages[0]["message-id"]
              : messages[0]?.["error-text"],
            status: messages[0]["status"] === "0" ? "sent" : "not sent",
          });
        } catch (e) {
          console.log("error sending sms");

          rej(e);
        }
      } else {
        ``;
        console.log("no valid senderId");
      }
    }
    res(smsSendingResults);
  });
};

app.listen(process.env.NERU_APP_PORT || 3000, () => {
  console.log(`listening on port ${process.env.NERU_APP_PORT}!`);
  // start();
});
// const customers = promise().then((result) => console.log(result));
