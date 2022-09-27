const checkSenderIdValid = (senderId) => /^[a-zA-Z0-9]*$/gm.test(senderId);
const senderHasLeadingPlus = (senderId) => senderId.contains('+');

const secondsTillEndOfDay = (now) => {
  //working with UTC. 16:00 UTC is 18 German Time
  const germanEndWorkingHour = new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 16)
  );
  const diffSeconds = parseInt(
    (germanEndWorkingHour.getTime() - now.getTime()) / 1000
  );
  return diffSeconds;
};

const IsWeekDay = (now) => {
  const dayOfWeek = now.getDay();
  return dayOfWeek > 0 && dayOfWeek < 6;
};

module.exports = {
  checkSenderIdValid,
  senderHasLeadingPlus,
  secondsTillEndOfDay,
  IsWeekDay,
};
