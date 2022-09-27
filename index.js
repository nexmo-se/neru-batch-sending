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
dotenv.config();
app.use(cors());
app.use(express.static('public'));

const fs = require('fs');

const csvWriter = createCsvWriter({
  path: 'smsresults.csv',
  header: [
    { id: 'to', title: 'to' },
    { id: 'message-id', title: 'message-id' },
    { id: 'status', title: 'status' },
  ],
});

app.use(bodyParser.json());

app.get('/_/health', async (req, res) => {
  res.sendStatus(200);
});

app.get('/dfiles', async (req, res) => {
  try {
    const session = neru.createSession();
    const assets = new Assets(session);
    const assetlist = await assets.binary('csv/test.csv').execute();
    console.log(assetlist);

    res.send(assetlist);
  } catch (e) {
    console.log(e);
  }
});

app.post('/checkandsend', async (req, res) => {
  console.log('Checking for files and sending if new CSV files exist...');
  const FILENAME = req.body.prefix || '/test.csv';
  const FILETYPES = 'send/';
  const PROCESSEDFILES = 'processedfiles';
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
      if (file && file.name.endsWith('.csv')) {
        toBeProcessed.push('/' + file.name);
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

      const fileBuffer = Buffer.from(asset.res.content, 'base64');
      // console.log('content: ', fileBuffer.toString());
      records = csvService.fromCsvSync(fileBuffer.toString(), {
        columns: true,
        delimiter: ';',
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
      console.log('...Done');
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
      if (utils.checkSenderIdValid(records[i]['VERPFLICHTUNGSNUMMER'])) {
        try {
          const response = await smsService.sendSms(
            records[i]['VERPFLICHTUNGSNUMMER'],
            records[i]['EOSTEAMRUECKRUFNUMMER'],
            records[i]['ANREDE'],
            process.env.apikey,
            process.env.apiSecret,
            'https://rest.nexmo.com/sms/json',
            '12',
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
        console.log('no valid senderId');
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
