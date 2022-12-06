Neru EOS sample app

## Pre-Requisites

1. Install NodeJS
2. Install [Neru CLI](https://vonage-neru.herokuapp.com/neru/overview)

## Installation

1. Run `npm install`
2. Run `neru configure` where you will be asked to set apikey and secret (Nexmo).
3. Create a `neru.yml` file as per `neru.sample.yml`

Next step is to configure the **appid** on Neru:

```
neru app configure --app-id your-app-id

```

## About the app

The app is intended to read CSV files periodically using the assets API from a folder called `/send`. The csv files will contain rows with references to templates (ID_SMSTEXT) created via a UI that this app exposes. There's a main scheduler running a cron job that gets executed every 30 minutes from Monday to Friday from 5 to 20.
If there are files to be processed, they will be passed to the `processAllFiles` function that parses the csv file and calculates whether there is enough time to process the file before the end of the working day (this is by design so that subscribers do not receive SMS after working hours).

1. If there is enough time to send all records and it's past 7 AM German time, the records will be passed to the `sendAllMessages` function of the smsService.
2. If there's not enough time to send all records, but it's earlier than the end of the working hours, the file will be split and the first file will be processed. The second file will be processed in the first iteration next morning.
3. If it's past 7 PM, the file won't be processed and will be processed in the next morning.

When there's a file processed several things happen afterwards.

1. A summary file is created containing the number of messages sent, the number of messages successful (OK from the API) in a directory called `/output`. The filename will be `${filename}-output.csv`
2. If there are messages failed, a failed csv file will be created in the `/output` directory. The filename will be `${filename}-failed-output.csv`
3. The file is moved to the `/processed` folder. `${filename}-processed.csv`

## App structure

The main file is `index.js` which contains all the application routes.

### UI

The UI has the following routes. Some of them are protected by a login mechanism. The login strategy is basic (email+password and can be found in `passport-strategy.js`). This sample app uses a dummy email and password, but the production instance the customer is using has more secure passwords. These emails and passwords are set as env variables and stored in the neru storage system.

`/api/templates`
It provides an array of objects with the existing templates in JSON format.

`/templates/new`
It provides a UI to create templates. Upon template creation the app will make a POST request that will store the new template.

`/templates`

It list the templates in a visual way.

### SMS service

The SMS service is a wrapper around the SMS API that sends all SMS from the records of the CSV file.

### CSV service

It parses the CSV files synchronously

### Rate Limiter service

It returns an axios instance with a configurable throughput. This application has 100 SMS per second throughput configured through an env variable.

## Starting the app

POST to `/scheduler` with {"command": "start", "maxInvocations": number}

This will start a cron job that runs every minute for 3 minutes (this is for testing purposes and needs to be changed for production)

This scheduler will call the `/checkandsend`endpoint which will check if there are csv files that need to be processed. If there are files that need to be processed, the file will be read, SMS sent and a new CSV file will be created on `/output` directory containing the results of the SMS sending.

## Stopping the app

POST to `/scheduler` with {"command": "stop"}

## Important considerations.

The neru instance goes to sleep after 1 minute of inactivity (inbound traffic). This app is started by an inbound request to the instance (by the scheduler) that triggers outbound requests (SMS API). The SMS sending process can take several minutes depending on the length of the csv file, therefore to prevent the instance from shutting down, there's a ping to the instance every second to keep the app alive while the SMS sending process is running.

## Debug

To debug the service, you can run `neru debug`.
