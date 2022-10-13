const { DateTime } = require('luxon');
const checkSenderIdValid = (senderId) => /^[a-zA-Z0-9]*$/gm.test(senderId);
const senderHasLeadingPlus = (senderId) => senderId.contains('+');

const now = DateTime.now().setZone('Europe/Berlin');
const germanTime = DateTime.fromObject({ day: now.c.day, hour: 15, minute: 16 }, { zone: 'Europe/Berlin' });

const secondsTillEndOfDay = () => {
  const diffSeconds = parseInt((germanTime - now) / 1000);
  return diffSeconds;
};

const resultsHeader = [
  { id: 'to', title: 'to' },
  { id: 'message-id', title: 'message-id' },
  { id: 'status', title: 'status' },
];

const processedFileHeader = [
  { id: 'ID', title: 'ID' },
  { id: 'EOSTEAMRUECKRUFNUMMER-id', title: 'EOSTEAMRUECKRUFNUMMER-id' },
  { id: 'ANREDE', title: 'ANREDE' },
  { id: 'NACHNAME', title: 'NACHNAME' },
  { id: 'VERPFLICHTUNGSNUMMER', title: 'VERPFLICHTUNGSNUMMER' },
  { id: 'MOBILTELEFONNUMMER', title: 'MOBILTELEFONNUMMER' },
  { id: 'EMAILADRESSE', title: 'EMAILADRESSE' },
  { id: 'FELD01', title: 'FELD01' },
  { id: 'FELD02', title: 'FELD02' },
  { id: 'FELD03', title: 'FELD03' },
  { id: 'FELD04', title: 'FELD04' },
  { id: 'FELD05', title: 'FELD05' },
  { id: 'FELD06', title: 'FELD06' },
  { id: 'FELD07', title: 'FELD07' },
  { id: 'FELD08', title: 'FELD08' },
  { id: 'FELD09', title: 'FELD09' },
  { id: 'FELD10', title: 'FELD10' },
];

module.exports = {
  checkSenderIdValid,
  senderHasLeadingPlus,
  secondsTillEndOfDay,
  resultsHeader,
  processedFileHeader,
};
