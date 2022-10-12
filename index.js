const express = require('express');
const csv = require('csv-parser');
const bodyParser = require('body-parser');
const app = express();
const cors = require('cors');
const path = require('path');
const flash = require('express-flash');
const session = require('express-session');
const methodOverride = require('method-override');
const passport = require('passport');
const apikey = process.env.apikey;
const apiSecret = process.env.apiSecret;
const api_url = 'https://rest.nexmo.com/sms/json';

const csvService = require('./services/csv');
const { neru, Assets, Scheduler } = require('neru-alpha');
const smsService = require('./services/sms');
const rateLimiterService = require('./services/rateLimiter');
const tps = parseInt(process.env.tps || '30', 10);
const rateLimitAxios = rateLimiterService.newInstance(tps);
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const utils = require('./utils');
const dotenv = require('dotenv');
const uuid = require('uuidv4');
const initializePassport = require('./passport-strategy');

dotenv.config();
app.use(cors());

app.use(flash());
app.use(
  session({
    secret: process.env.apiSecret,
    resave: false,
    saveUninitialized: false,
  })
);

app.use(passport.initialize());
app.use(passport.session());
app.use(methodOverride('_method'));
const users = [
  {
    id: 1,
    name: 'Javi',
    email: 'javiermolsanz@gmail.com',
    password: '1234',
  },
];

initializePassport(
  passport,
  async (email) => {
    const globalState = neru.getGlobalState();
    const customer = await globalState.hget('users', email);
    return customer;
    if (!customer) return null;
    // users.find((user) => user.email === email);
  },
  (id) => users.find((user) => user.id === id)
);

const fs = require('fs');

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

// TEMPLATE VIEWS START
// Get a list of templates as ejs view
app.get('/templates', checkAuthenticated, async (req, res) => {
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
app.get('/templates/new', checkAuthenticated, async (req, res) => {
  res.render('templates/new', {});
});
// TEMPLATE VIEWS END

app.get('/login', checkNotAuthenticated, (req, res) => {
  res.render('templates/login', {});
});

app.post(
  '/login',
  checkNotAuthenticated,
  passport.authenticate('local', {
    successRedirect: '/templates/new',
    failureRedirect: '/login',
    failureFlash: true,
  })
);
app.get('/', (req, res) => {
  res.redirect('/login');
});

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
    return res.status(404).json({ success: false, error: 'please provide a valid id' });
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
      error: 'please provide at least a valid text and senderIdField and also an id in case of updating existing templates.',
    });
  }
});

// Delete a template by ID
app.delete('/api/templates/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(404).json({ success: false, error: 'please provide a valid id' });
  }
  const globalState = neru.getGlobalState();
  const deleted = await globalState.hdel(TEMPLATES_TABLENAME, id);
  res.json({ success: true, deleted });
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

// app.get('/state', async (req, res) => {
//   const globalState = neru.getGlobalState();
//   const emailBueno = 'javiermolsanz@gmail.com';
//   const created = await globalState.hset('users', {
//     [emailBueno]: JSON.stringify({
//       id: 1,
//       emailBueno: 'javiermolsanz@gmail.com',
//       password: 'sdd',
//     }),
//   });
//   await globalState.hset('users', {
//     ['wd']: JSON.stringify({
//       id: 1,
//       emailBueno: 'javiesddrmolsanz@gmail.com',
//       password: 'sdsssd',
//     }),
//   });

//   const customer = await globalState.hgetall('users');

//   if (customer) res.send(customer);
//   else res.send('no customer found');
// });

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
    const secondsTillEndOfDay = utils.secondsTillEndOfDay();

    let toBeProcessed = [];

    if (!assetlist || !assetlist.res || assetlist.res.length <= 0) {
      console.warn('Found no new csv files in asset list.');
      return res.json({
        success: false,
        error: 'No new files found but no error.',
      });
    }
    assetlist.res.forEach((file) => {
      if (file && file.name && file.name.endsWith('.csv') && (!lastCheck || new Date(file.lastModified) > new Date(lastCheck))) {
        toBeProcessed.push('/' + file.name);
      } else {
        ///TO DO: MAKE SURE THAT IF THE FILE IS NOT PROCESSED BECAUSE WE'RE AT THE END OF THE DAY, IT IS STILL PICKED UP
        console.log('I will not send since the file is already processed');
        console.log(new Date(file.lastModified), new Date(lastCheck));
      }
      //toBeProcessed.push("/" + file.name);
    });

    let asset;
    let records;
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
      const secondsTillEndOfDay = utils.secondsTillEndOfDay();
      const secondsNeededToSend = parseInt((records.length - 1) / tps);
      //only send if there's enough time till the end of the working day
      if (secondsTillEndOfDay > secondsNeededToSend) {
        console.log(`There are ${secondsTillEndOfDay} sec left and I need ${secondsNeededToSend}`);
        const sendingResults = await sendSms(records);
        const resultsToWrite = sendingResults.map((result) => {
          return {
            to: result.to ? result.to : undefined,
            'message-id': result['message-id'] ? result['message-id'] : result['error-text'],
            status: result['status'] === '0' ? 'sent' : 'not sent',
          };
        });
        const path = filename.split('/')[2].replace('.csv', '-output.csv');
        await writeResults(resultsToWrite, path, utils.resultsHeader);
        const result = await assets.uploadFiles([path], `output/`).execute();
        //assets, pathFrom, pathTo, records, filename
        const processedPath = filename.split('/')[2].replace('.csv', '-processed.csv');
        const fileMoved = await moveFile(assets, processedPath, 'processed/', records, filename);
      } else if (secondsTillEndOfDay < 0) {
        console.log('cannot send, end of day');
      } else if (secondsTillEndOfDay > 0 && secondsNeededToSend > secondsTillEndOfDay) {
        console.log('there is no time to send all the records. Splitting file... ');

        console.log('I have ' + secondsTillEndOfDay + ' to send');
        //10 % security
        const numberOfRecordsToSend = parseInt(tps * secondsTillEndOfDay * 0.9);
        console.log('I can send ' + numberOfRecordsToSend);

        //slice does not include the element
        //send the messages until the end of the allowed period
        const sendingRecords = records.slice(0, numberOfRecordsToSend);
        const sendingResults = await sendSms(sendingRecords);
        const resultsToWrite = sendingResults.map((result) => {
          return {
            to: result.to ? result.to : undefined,
            'message-id': result['message-id'] ? result['message-id'] : result['error-text'],
            status: result['status'] === '0' ? 'sent' : 'not sent',
          };
        });
        //write the resuls file
        const uploadPath = filename.split('/')[2].replace('.csv', '-1-output.csv');
        await writeResults(resultsToWrite, uploadPath, utils.resultsHeader);
        await assets.uploadFiles([uploadPath], `output/`).execute();
        //move the subfile that has been processed to the processed folder
        const processedPath = filename.split('/')[2].replace('.csv', '-1-processed.csv');
        await moveFile(assets, processedPath, 'processed/', sendingRecords, filename);
        //upload the pending records to be processed next morning
        const newFile = records.slice(numberOfRecordsToSend, records.length);
        const pathToFile = filename.split('/')[2].replace('.csv', '-1.csv');
        await writeResults(newFile, pathToFile, utils.processedFileHeader);
        const result = await assets.uploadFiles([pathToFile], `send/`).execute();
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

const writeResults = async (results, path, header) => {
  const csvWriter = createCsvWriter({
    fieldDelimiter: ';',
    path: path,
    header: header,
  });
  // if (results.length) {
  csvWriter
    .writeRecords(results) // returns a promise
    .then(() => {
      console.log('...Done');
    })
    .catch((e) => console.log(`Something wrong while writting the output csv ${e}`));
};

const sendSms = async (records) => {
  const globalState = neru.getGlobalState();
  const templates = await globalState.hgetall(TEMPLATES_TABLENAME);
  const parsedTemplates = Object.keys(templates).map((key) => {
    const data = JSON.parse(templates[key]);
    return { ...data };
  });

  try {
    const promises = records.map(async (record) => {
      try {
        const template = parsedTemplates.find((template) => template.id === record[CSV_TEMPLATE_ID_COLUMN_NAME]);
        let text = template?.text;
        const senderNumber = `${record[`${template?.senderIdField}`]?.replaceAll('+', '')}`;

        const to = `${record[CSV_PHONE_NUMBER_COLUMN_NAME]?.replaceAll('+', '')}`;
        const client_ref = record['VERPFLICHTUNGSNUMMER'];

        const regexp = /\{\{\s?([\w\d]+)\s?\}\}/g;
        if (text) {
          // now, find all placeholders in the template text by using the regex above
          const matchArrays = [...text.matchAll(regexp)];
          // for each placeholder, replace it with the value of the csv column that it references
          matchArrays.forEach((array) => {
            text = text.replaceAll(array[0], record[`${array[1]}`]);
          });
        }

        // Add to queue
        const result = await smsService.sendSms(senderNumber, to, text, apikey, apiSecret, api_url, client_ref, rateLimitAxios);
        return Promise.resolve(Object.assign({}, result.messages[0]));
      } catch (error) {
        return Promise.reject(error);
      }
    });
    const results = await Promise.all(promises);
    return results;
  } catch (error) {
    console.error(error);
    return error;
  }
};

const moveFile = (assets, pathFrom, pathTo, records, filename) => {
  return new Promise(async (res, rej) => {
    try {
      await writeResults(records, pathFrom, utils.processedFileHeader);
      console.log('uploading file to processed folder');

      await assets.uploadFiles([pathFrom], pathTo).execute();
      console.log('removing file from send folder' + filename);
      await assets.remove(filename).execute();
      res();
    } catch (e) {
      console.log(`Something wrong while moving the csv file ${e}`);
      rej(e);
    }
  });
};

function checkAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  res.redirect('/login');
}
function checkNotAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return res.redirect('/templates');
  }
  next();
}

app.listen(process.env.NERU_APP_PORT || 3000, async () => {
  console.log(`listening on port ${process.env.NERU_APP_PORT}!`);
  const globalState = neru.getGlobalState();
  const email = 'javiermolsanz@gmail.com';
  await globalState.hset('users', {
    [email]: JSON.stringify({
      id: 1,
      email: email,
      name: 'Javi',
      password: '1234',
    }),
  });
  // start();
});
// const customers = promise().then((result) => console.log(result));
