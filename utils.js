const { DateTime } = require('luxon');
const checkSenderIdValid = (senderId) => /^[a-zA-Z0-9]*$/gm.test(senderId);
const senderHasLeadingPlus = (senderId) => senderId.contains('+');

const now = DateTime.now().setZone('Europe/Berlin');
const germanTime = DateTime.fromObject(
  { day: now.c.day, hour: 20 },
  { zone: 'Europe/Berlin' }
);

const secondsTillEndOfDay = () => {
  const diffSeconds = parseInt((germanTime - now) / 1000);
  return diffSeconds;
};

module.exports = {
  checkSenderIdValid,
  senderHasLeadingPlus,
  secondsTillEndOfDay,
};
