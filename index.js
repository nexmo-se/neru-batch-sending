const express = require('express');
const csv = require('csv-parser');
const bodyParser = require('body-parser');
const app = express();
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const memoryStorage = multer.memoryStorage();
const upload = multer({ storage: memoryStorage }).single('file');
const csvService = require('./services/csv');
const { neru, Assets, Scheduler, Messages } = require('neru-alpha');
const smsService = require('./services/sms');
const rateLimiterService = require('./services/rateLimiter');
const tps = parseInt(process.env.TPS || '30', 10);
const rateLimitAxios = rateLimiterService.newInstance(tps);
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const utils = require('./utils');
const dotenv = require('dotenv');
const uuid = require('uuidv4');
dotenv.config();
app.use(cors());

const fs = require('fs');

const csvWriter = createCsvWriter({
  path: 'smsresults.csv',
  header: [
    { id: 'to', title: 'to' },
    { id: 'message-id', title: 'message-id' },
    { id: 'status', title: 'status' },
  ],
});

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
// set view engine to ejs
app.set('view engine', 'ejs');

app.get('/_/health', async (req, res) => {
  res.sendStatus(200);
});

const TEMPLATES_TABLENAME = 'TEMPLATES';
// neru tablename for processed filenames
const PROCESSEDFILES_TABLENAME = 'processedfiles';
// column name of csv file that contains the template ID
const CSV_TEMPLATE_ID_COLUMN_NAME = 'ID_SMSTEXT';
// column name of csv file that contains the phone number of the receiver
const CSV_PHONE_NUMBER_COLUMN_NAME = 'MOBILTELEFONNUMMER';
// column name of csv file that contains the ID that will be put into account_ref (together with csv filename)
const CSV_ID_COLUMN_NAME = 'ID';
// column name of csv file that contains the ID that will be put in the client_ref field
const CSV_CLIENT_REF_COLUMN_NAME = 'VERPFLICHTUNGSNUMMER';
// cron job definition, default is every minute '* * * * *'
// for EOS, we could use '0 9-18 * * 1-5' to run: At minute 0 past every hour from 9 through 18 on every day-of-week from Monday through Friday.
// this makes sure that no one gets sendouts at weekends or in the middle of the night adn check for new files hourly within the given times and days
const CRONJOB_DEFINITION = '* * * * *';
// cancel all monitoring schedulers when server crashes or not
const ON_CRASH_CANCEL_MONITOR = false;

// allow to parse json bodies and form data if needed

// TODO: add simple authentication middleware like username/pw with express-session or passport.js for everything

// TEMPLATE VIEWS START
// Get a list of templates as ejs view
app.get('/templates', async (req, res) => {
  const globalState = neru.getGlobalState();
  const templates = await globalState.hgetall(TEMPLATES_TABLENAME);
  const parsedTemplates = Object.keys(templates).map((key) => {
    const data = JSON.parse(templates[key]);
    return { ...data };
  });
  console.log(JSON.stringify(parsedTemplates));
  res.render('templates/index', { templates: parsedTemplates });
});

// Get a form to create a new template
app.get('/templates/new', async (req, res) => {
  res.render('templates/new', {});
});
// TEMPLATE VIEWS END

// TEMPLATE API START
// Get a list of all templates
app.get('/api/templates', async (req, res) => {
  const globalState = neru.getGlobalState();
  const templates = await globalState.hgetall(TEMPLATES_TABLENAME);
  const parsedTemplates = Object.keys(templates).map((key) => {
    const data = JSON.parse(templates[key]);
    return { ...data };
  });
  res.json(parsedTemplates);
});

// Get a single temaplte by id
app.get('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res
      .status(404)
      .json({ success: false, error: 'please provide a valid id' });
  }
  const globalState = neru.getGlobalState();
  const template = await globalState.hget(TEMPLATES_TABLENAME, id);
  const parsedTemplate = await JSON.parse(template);
  res.json(parsedTemplate);
});

// Create a new template
app.post('/api/templates', async (req, res) => {
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
        'please provide at least a valid text and senderIdField and also an id in case of updating existing templates.',
    });
  }
});

// Delete a template by ID
app.delete('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res
      .status(404)
      .json({ success: false, error: 'please provide a valid id' });
  }
  const globalState = neru.getGlobalState();
  const deleted = await globalState.hdel(TEMPLATES_TABLENAME, id);
  res.json({ success: true, deleted });
});

app.get('/dfiles', async (req, res) => {
  try {
    const session = neru.createSession();
    const assets = new Assets(session);
    // const asset = await assets.getRemoteFile('send/test.csv').execute();
    const assetlist = await assets
      .uploadFiles(['smsresults.csv'], 'send/')
      .execute();
    console.log(assetlist);

    res.send('okay');
  } catch (e) {
    console.log(e);
  }
});

// Scheduler API that is responsible for starting or stopping the neru scheduler that constantly checks for new csv files in the neru assets directory that was specified
// The endAtDate and maxInvocations should be removed unless in debug mode, because this scheduler should always be running as a cron job.
// We could use an env var to define the timeframe or cron for when it should run.
app.post('/scheduler', async (req, res) => {
  const { command, maxInvocations } = req.body;
  const session = neru.createSession();
  const scheduler = new Scheduler(session);

  if (command == 'start') {
    // create scheduler with fix name that checks for new files and sends them
    let startAtDate = new Date(); // default is now

    // TODO: debug stuff... change later or simply do not supply a maxInvocations parameter
    // the following block limits the time and invocations for how often the scheduler can run,
    // this is in in case the demo fail and we don't want dead schedulers ghosting around calling apis every minute forever
    let endAtDate = new Date();
    endAtDate.setDate(endAtDate.getDate() + 1); // runs for max 1 day
    let until = {};
    let maxInvocationsInt = parseInt(maxInvocations);
    if (maxInvocations && maxInvocationsInt && maxInvocationsInt > 0) {
      until = {
        until: {
          date: endAtDate.toISOString(), // just ot be sure also limit days for demo purpose
          maxInvocations: maxInvocationsInt, // max 1 hour with one invocation per minute
        },
      };
    }

    const schedulerCreated = await scheduler
      .startAt({
        id: 'checkandsender',
        startAt: startAtDate.toISOString(),
        callback: '/checkandsend',
        interval: {
          cron: CRONJOB_DEFINITION,
          ...until,
        },
      })
      .execute();
    res.json({ schedulerCreated });
  } else if (command == 'stop') {
    // delete scheduler with fix name
    const schedulerDeleted = await scheduler.cancel('checkandsender').execute();
    res.json({ schedulerDeleted });
  }
});

app.post('/checkandsend', async (req, res) => {
  console.log('Checking for files and sending if new CSV files exist...');
  const FILENAME = req.body.prefix || '/test.csv';
  const FILETYPES = 'send/';
  const PROCESSEDFILES = 'processedfiles';
  try {
    // set global state for database access
    const globalState = neru.getGlobalState();
    // create a neru session
    const session = neru.createSession();
    // init assets access
    const assets = new Assets(session);

    const lastCheck = await globalState.get('lastCsvCheck');

    // get file list from assets api
    const assetlist = await assets.list(FILETYPES, false, 10).execute();
    console.log(assetlist);

    const newCheck = new Date().toISOString();
    const savedNewCheck = await globalState.set('lastCsvCheck', newCheck);
    // const savedNewCheck = await globalState.set('lastCsvCheck', newCheck);
    // const savedNewCheck = await globalState.set('lastCsvCheck', {
    //   [date]: JSON.stringify({ newCheck }),
    // });

    let toBeProcessed = [];

    if (!assetlist || !assetlist.res || assetlist.res.length <= 0) {
      console.warn('Found no new csv files in asset list.');
      return res.json({
        success: false,
        error: 'No new files found but no error.',
      });
    }
    assetlist.res.forEach((file) => {
      if (
        file &&
        file.name &&
        file.name.endsWith('.csv') &&
        //TO DO: check why this is not true
        (!lastCheck || new Date(file.lastModified) > new Date(lastCheck))
      ) {
        toBeProcessed.push('/' + file.name);
      } else {
        console.log('I will not send since the file is already processed');
        console.log(new Date(file.lastModified), new Date(lastCheck));
      }
      //toBeProcessed.push("/" + file.name);
    });

    let asset;
    let records;
    let responses = [];
    let savedAsProcessedFile;

    toBeProcessed.forEach(async (filename) => {
      // process and send the file
      console.log('processing file');

      asset = await assets.getRemoteFile(filename).execute();
      const fileBuffer = asset;
      records = csvService.fromCsvSync(fileBuffer.toString(), {
        columns: true,
        delimiter: ';',
      });
      console.log(records);
      const secondsTillEndOfDay = utils.secondsTillEndOfDay(new Date());

      //only send if there's enough time till the end of the working day
      if (secondsTillEndOfDay > parseInt((records.length - 1) / 30)) {
        const sendingResults = await sendSms(records);

        await writeResults(sendingResults);
        const result = await assets
          .uploadFiles(['smsresults.csv'], `output/`)
          .execute();
        console.log(result);
      } else {
        console.log('there is not time');
      }
      // save info that file was processed already
      savedAsProcessedFile = await globalState.rpush(PROCESSEDFILES, FILENAME);
    });
    res.sendStatus(200);
  } catch (e) {
    console.log('check and send error: ', e.message);
    res.sendStatus(500);
  }
});

app.get('/test', async (req, res) => {
  const results = [];
  fs.createReadStream('test.csv')
    .pipe(csv({ separator: ';' }))
    .on('data', (data) => {
      results.push(data);
    })
    .on('end', async () => {
      const secondsTillEndOfDay = utils.secondsTillEndOfDay(new Date());

      if (secondsTillEndOfDay > parseInt((results.length - 1) / 30)) {
        // modifyRecords(results);
        const sendingResults = await sendSms(results);
        // await writeResults(sendingResults);

        // res.json(sendingResults);
        res.sendStatus(200);
      }
      // res.sendStatus(200);
    });
});

const writeResults = async (results) => {
  // if (results.length) {
  csvWriter
    .writeRecords(results) // returns a promise
    .then(() => {
      console.log('...Done');
    })
    .catch((e) =>
      console.log(`Something wrong while writting the output csv ${e}`)
    );
};

const sendSms = async (records) => {
  let smsSendingResults = [];
  const globalState = neru.getGlobalState();

  return new Promise(async (res, rej) => {
    for (let i = 0; i < records.length; i++) {
      // const template = {
      //   id: 'bhg',
      //   text: 'Hello you',
      //   senderIdField: 'EOSTEAMRUECKRUFNUMMER',
      //   updatedAt: '2022-09-28T12:18:49.035Z',
      // };

      //ID;EOSTEAMRUECKRUFNUMMER;ID_SMSTEXT;ANREDE;NACHNAME;VERPFLICHTUNGSNUMMER;MOBILTELEFONNUMMER;EMAILADRESSE;FELD01;FELD02;FELD03;FELD04;FELD05;FELD06;FELD07;FELD08;FELD09;FELD10

      //this is for prod
      const templateJson = await globalState.hget(
        TEMPLATES_TABLENAME,
        records[i][CSV_TEMPLATE_ID_COLUMN_NAME]
      );
      console.log(templateJson);

      const template = await JSON.parse(templateJson);
      console.log(template);

      //prod end here

      // get the template text into a variable
      let text = template?.text;

      const senderNumber = `${records[i][
        `${template?.senderIdField}`
      ]?.replaceAll('+', '')}`;

      const to = `${records[i][CSV_PHONE_NUMBER_COLUMN_NAME]?.replaceAll(
        '+',
        ''
      )}`;

      const client_ref = records[i]['VERPFLICHTUNGSNUMMER'];

      // set regular expression that matches all placeholders in the temaplte.
      // For example, it matches two times for: "Hello {{ FIRSTNAME }}, you have an appoitnment at {{DATE}}!"
      const regexp = /\{\{\s?([\w\d]+)\s?\}\}/g;
      if (text) {
        // now, find all placeholders in the template text by using the regex above
        const matchArrays = [...text.matchAll(regexp)];

        // for each placeholder, replace it with the value of the csv column that it references
        matchArrays.forEach((array) => {
          text = text.replaceAll(array[0], records[i][`${array[1]}`]);
        });
      }
      if (utils.checkSenderIdValid(senderNumber) && to && text) {
        try {
          const response = await smsService.sendSms(
            senderNumber,
            to,
            text,
            process.env.apikey,
            process.env.apiSecret,
            'https://rest.nexmo.com/sms/json',
            client_ref,
            rateLimitAxios
          );
          const { messages } = response;
          console.log(messages);

          smsSendingResults.push({
            to: messages[0].to,
            'message-id': messages[0]?.['message-id']
              ? messages[0]['message-id']
              : messages[0]?.['error-text'],
            status: messages[0]['status'] === '0' ? 'sent' : 'not sent',
          });
        } catch (e) {
          console.log('error sending sms');

          rej(e);
        }
      } else {
        smsSendingResults.push({
          to: to,
          'message-id': undefined,
          status: 'not sent',
        });
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
