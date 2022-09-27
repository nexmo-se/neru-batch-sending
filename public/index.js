window.addEventListener('load', (event) => {
  const handleCallback = (response) => {
    console.log(response);
  };

  google.accounts.id.initialize({
    client_id:
      '298050859926-dbobvueegpn68h60pigoekkgbv4s714b.apps.googleusercontent.com',
    callback: handleCallback,
  });

  google.accounts.id.renderButton(document.getElementById('signIn'), {
    theme: 'filled_blue',
    size: 'large',
  });
  google.accounts.render;
  const fileInput = document.getElementById('formFileSm');
  fileInput.addEventListener('change', function (event) {
    event.preventDefault();
    handleFiles(event.target.files);
  });

  const handleFiles = (files) => {
    const file = files[0];
    var data = new FormData();
    data.append('file', file);

    fetch('/file', {
      method: 'POST',
      body: data,
    })
      .then((response) => response.json())
      .then((data) => console.log(data))
      .catch(
        (error) => console.log(error) // Handle the error response object
      );
  };
});
