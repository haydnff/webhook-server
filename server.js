const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post('/webhook', (req, res) => {
  console.log('Received webhook:', JSON.stringify(req.body, null, 2));
  res.status(200).send('received');
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
