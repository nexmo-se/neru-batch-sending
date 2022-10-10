// eslint-disable-next-line no-control-regex
const isUnicode = (text) => /[^\u0000-\u00ff]/.test(text);

const sendNothing = () => {
  return new Promise((res, rej) => {
    setTimeout(() => {
      res({
        'message-count': '1',
        messages: [
          {
            to: '447700900000',
            'message-id': '0A0000000123ABCD1',
            status: '0',
            'remaining-balance': '3.14159265',
            'message-price': '0.03330000',
            network: '12345',
            'client-ref': 'my-personal-reference',
            'account-ref': 'customer1234',
          },
        ],
      });
    }, 12.5);
  });
};

const sendSms = (
  from,
  to,
  text,
  apiKey,
  apiSecret,
  apiUrl,
  campaignName,
  axios
) => {
  // Determine proper type to send as
  const type = isUnicode(text) ? 'unicode' : 'text';

  // Constructing the API Request Body
  const body = {
    api_key: apiKey,
    api_secret: apiSecret,
    from,
    to,
    text,
    type,
    'client-ref': campaignName,
  };

  return axios
    .post(apiUrl, body)
    .then((response) => {
      const { data } = response;
      return Promise.resolve(data);
    })
    .catch((error) => {
      // Check for 429: Too Many Requests
      if (error.response != null && error.response.status === 429) {
        console.log('Too many request (429) detected, put back into queue');

        // Recursively call self, to put request back into queue
        return sendSms(
          from,
          to,
          text,
          apiKey,
          apiSecret,
          apiUrl,
          campaignName,
          axios
        );
      }

      console.error(error.message);
      console.error(error);
      return Promise.reject(error);
    });
};

module.exports = {
  sendSms,
  sendNothing,
};
