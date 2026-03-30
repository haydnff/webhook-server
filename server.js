require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;
const DROPBOX_ACCESS_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;

app.post('/webhook', async (req, res) => {
  const { order_id, agent_email, property_address, package_type } = req.body;

  if (!order_id || !agent_email || !property_address || !package_type) {
    return res.status(400).json({
      error: 'Missing required fields: order_id, agent_email, property_address, package_type',
    });
  }

  const { error } = await supabase
    .from('listings')
    .insert({ order_id, agent_email, property_address, package_type });

  if (error) {
    console.error('Supabase insert error:', error.message);
    return res.status(500).json({ error: 'Failed to save listing' });
  }

  return res.status(200).json({ success: true, order_id });
});

app.post('/webhook/dropbox', async (req, res) => {
  const { order_id, dropbox_folder_path } = req.body;

  if (!order_id || !dropbox_folder_path) {
    return res.status(400).json({
      error: 'Missing required fields: order_id, dropbox_folder_path',
    });
  }

  const { error } = await supabase
    .from('listings')
    .update({ dropbox_folder_path })
    .eq('order_id', order_id);

  if (error) {
    console.error('Supabase update error:', error.message);
    return res.status(500).json({ error: 'Failed to update listing' });
  }

  console.log(`[Dropbox] Updated order ${order_id} → ${dropbox_folder_path}`);
  return res.status(200).json({ success: true, order_id, dropbox_folder_path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
