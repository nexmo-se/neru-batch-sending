const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const uuid = require('uuidv4');
const cors = require('cors');
const flash = require('express-flash');
const methodOverride = require('method-override');
const passport = require('passport');
const tps = parseInt(process.env.tps || '30', 10);
const cookieSession = require('cookie-session');
const { neru, Assets, Scheduler } = require('neru-alpha');

const csvService = require('./services/csv');
const smsService = require('./services/sms');
const constants = require('./constants');
const keepAlive = require('./services/keepalivescheduler');
const utils = require('./utils');
const initializePassport = require('./passport-strategy');

const globalState = neru.getGlobalState();
const CRONJOB_DEFINITION_SCHEDULER = '0 9-20 * * 1-5';
const TEMPLATES_TABLENAME = 'TEMPLATES';

const EOS_CRONJOB = '15,45 6-20 * * 1-6';

// cancel all monitoring schedulers when server crashes or not
const ON_CRASH_CANCEL_MONITOR = false;

app.use(cors());
app.use(flash());
app.use(
  cookieSession({
    name: 'session',
    keys: ['secretcat'],
    secure: false,
    resave: false,
    maxAge: 24 * 60 * 60 * 1000,
  })
);

app.use(passport.initialize());
app.use(passport.session());
app.use(methodOverride('_method'));

initializePassport(
  passport,
  async (email) => {
    const globalState = neru.getGlobalState();
    const customer = await globalState.hget('users', email);
    return JSON.parse(customer);
    if (!customer) return null;
  },
  async (email) => {
    const globalState = neru.getGlobalState();
    const customer = await globalState.hget('users', email);
    return customer;
  }
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.set('view engine', 'ejs');

app.get('/_/health', async (req, res) => {
  res.sendStatus(200);
});

//this is to keep alive the neru app while writting files to avoid restarts
app.post('/keepalive', (req, res) => {
  console.log('keep alive ping');
  res.sendStatus(200);
});

app.get('/login', utils.checkNotAuthenticated, (req, res) => {
  res.render('templates/login', {});
});

app.get('/', utils.checkNotAuthenticated, (req, res) => {
  res.redirect('/login');
});

app.post(
  '/login',
  utils.checkNotAuthenticated,
  passport.authenticate('local', {
    successRedirect: '/templates/new',
    failureRedirect: '/login',
    failureFlash: true,
  })
);

// TEMPLATE VIEWS START
// Get a list of templates as ejs view
app.get('/templates', utils.checkAuthenticated, async (req, res) => {
  const templates = await globalState.hgetall(TEMPLATES_TABLENAME);
  const parsedTemplates = Object.keys(templates).map((key) => {
    const data = JSON.parse(templates[key]);
    return { ...data };
  });
  console.log(JSON.stringify(parsedTemplates));
  res.render('templates/index', { templates: parsedTemplates });
});

// Get a form to create a new template
app.get('/templates/new', utils.checkAuthenticated, async (req, res) => {
  res.render('templates/new', {});
});

// TEMPLATE VIEWS END

// TEMPLATE API START
// Get a list of all templates

app.get('/api/templates', async (req, res) => {
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
  const template = await globalState.hget(TEMPLATES_TABLENAME, id);
  const parsedTemplate = await JSON.parse(template);
  res.json(parsedTemplate);
});

// Create a new template
app.post('/api/templates', async (req, res) => {
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
  const deleted = await globalState.hdel(TEMPLATES_TABLENAME, id);
  res.json({ success: true, deleted });
});

//End of template APIs

// Scheduler API that is responsible for starting or stopping the neru scheduler that constantly checks for new csv files in the neru assets directory that was specified
// The endAtDate and maxInvocations should be removed unless in debug mode, because this scheduler should always be running as a cron job.
// We could use an env var to define the timeframe or cron for when it should run.
app.post('/scheduler', async (req, res) => {
  const { command, maxInvocations } = req.body;
  const session = neru.createSession();
  const scheduler = new Scheduler(session);

  if (command == 'start') {
    let startAtDate = new Date(); // default is now
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
          cron: EOS_CRONJOB,
          // ...until,
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
  const FILETYPES = 'send/';
  const PROCESSEDFILES = 'processedfiles';
  try {
    // create a neru session
    const session = neru.createSession();
    // init assets access
    const assets = new Assets(session);
    const lastCheck = await globalState.get('lastCsvCheck');
    const processingFiles = await globalState.get('processingState');
    // get file list from assets api
    const assetlist = await assets.list(FILETYPES, false, 10).execute();
    // console.log(assetlist);
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
      if (
        file &&
        file.name &&
        file.name.endsWith('.csv') &&
        (!lastCheck || new Date(file.lastModified) > new Date(lastCheck)) &&
        !processingFiles
      ) {
        toBeProcessed.push('/' + file.name);
      } else {
        console.log('I will not send since the file is already processed or there are files being processed');
      }
    });

    let records;

    toBeProcessed.forEach(async (filename) => {
      // process and send the file
      console.log('processing file');
      try {
        const asset = await assets.getRemoteFile(filename).execute();
        records = csvService.fromCsvSync(asset.toString(), {
          columns: true,
          delimiter: ';',
          skip_empty_lines: true,
          skip_lines_with_error: true,
        });
      } catch (e) {
        console.log('there was an error parsing the csv file' + e);
        await globalState.set('processingState', false);
        await keepAlive.deleteKeepAlive();
      }
      const secondsTillEndOfDay = utils.secondsTillEndOfDay();
      const secondsNeededToSend = parseInt((records.length - 1) / tps);
      //only send if there's enough time till the end of the working day
      if (secondsTillEndOfDay > secondsNeededToSend) {
        try {
          await globalState.set('processingState', true);
          await keepAlive.createKeepAlive();
          const newCheck = new Date().toISOString();
          const savedNewCheck = await globalState.set('lastCsvCheck', newCheck);
          console.log(`There are ${secondsTillEndOfDay} sec left and I need ${secondsNeededToSend}`);
          const startProcessingDate = new Date().toISOString();
          const sendingResults = await smsService.sendAllMessages(records, filename);
          const endProcessingDate = new Date().toISOString();
          const failedResults = sendingResults.filter((result) => result.status !== '0');
          const failedSummary = [
            {
              failed: failedResults.length,
              successful: sendingResults.length - failedResults.length,
              startAt: startProcessingDate,
              endAt: endProcessingDate,
            },
          ];
          const Failedpath = filename.split('/')[2].replace('.csv', '-failed-output.csv');
          await utils.writeResults(failedResults, Failedpath, constants.failedResultsHeader);
          await assets.uploadFiles([Failedpath], `output/`).execute();
          const path = filename.split('/')[2].replace('.csv', '-output.csv');
          await utils.writeResults(failedSummary, path, constants.failedHeader);
          // await utils.writeResults(resultsToWrite, path, constants.resultsHeader);
          const result = await assets.uploadFiles([path], `output/`).execute();
          const processedPath = filename.split('/')[2].replace('.csv', '-processed.csv');
          const fileMoved = await utils.moveFile(assets, processedPath, 'processed/', records, filename);
          await globalState.set('processingState', false);
          await keepAlive.deleteKeepAlive();
        } catch (e) {
          await globalState.set('processingState', false);
          await keepAlive.deleteKeepAlive();
        }
      } else if (secondsTillEndOfDay < 0) {
        console.log('cannot send, end of day');
      } else if (secondsTillEndOfDay > 0 && secondsNeededToSend > secondsTillEndOfDay) {
        console.log('there is no time to send all the records. Splitting file... ');
        await globalState.set('processingState', true);
        console.log('I have ' + secondsTillEndOfDay + ' to send');
        //10 % security
        const numberOfRecordsToSend = parseInt(tps * secondsTillEndOfDay * 0.9);
        console.log('I can send ' + numberOfRecordsToSend);

        //send the messages until the end of the allowed period
        await keepAlive.createKeepAlive();
        const sendingRecords = records.slice(0, numberOfRecordsToSend);
        const startProcessingDate = new Date().toISOString();
        const sendingResults = await smsService.sendAllMessages(sendingRecords, filename);
        const endProcessingDate = new Date().toISOString();
        const failedResults = sendingResults.filter((result) => result.status !== '0');
        const failedSummary = [
          {
            failed: failedResults.length,
            successful: sendingResults.length - failedResults.length,
            startAt: startProcessingDate,
            endAt: endProcessingDate,
          },
        ];
        //write the resuls file
        const Failedpath = filename.split('/')[2].replace('.csv', '-failed-1-output.csv');
        await utils.writeResults(failedResults, Failedpath, constants.failedResultsHeader);
        await assets.uploadFiles([Failedpath], `output/`).execute();
        const path = filename.split('/')[2].replace('.csv', '-1-output.csv');
        await utils.writeResults(failedSummary, path, constants.failedHeader);
        await assets.uploadFiles([path], `output/`).execute();

        //move the subfile that has been processed to the processed folder
        const processedPath = filename.split('/')[2].replace('.csv', '-1-processed.csv');
        await utils.moveFile(assets, processedPath, 'processed/', sendingRecords, filename);
        //upload the pending records to be processed next morning
        const newFile = records.slice(numberOfRecordsToSend, records.length);
        const pathToFile = filename.split('/')[2].replace('.csv', '-2.csv');
        await utils.writeResults(newFile, pathToFile, constants.processedFileHeader);
        const result = await assets.uploadFiles([pathToFile], `send/`).execute();
        await globalState.set('processingState', false);
        await keepAlive.deleteKeepAlive();
      }

      // save info that file was processed already
    });

    res.sendStatus(200);
  } catch (e) {
    console.log('check and send error: ', e.message);
    res.sendStatus(500);
  }
});

app.listen(process.env.NERU_APP_PORT || 3000, async () => {
  console.log(`listening on port ${process.env.NERU_APP_PORT}!`);
  const email = 'javiermolsanz@gmail.com';
  await globalState.hset('users', {
    [email]: JSON.stringify({
      id: 1,
      email: email,
      name: 'Javi',
      password: '1234',
    }),
  });
  await globalState.set('processingState', false);
});
