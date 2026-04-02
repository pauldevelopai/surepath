require('dotenv').config();
const express = require('express');
const whatsappRouter = require('./whatsapp');
const b2bRouter = require('./b2b-api');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(whatsappRouter);
app.use(b2bRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'surepath' });
});

app.listen(PORT, () => {
  console.log(`Surepath server running on port ${PORT}`);
});

module.exports = app;
