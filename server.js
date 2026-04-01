require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DROPBOX_APP_KEY = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET = process.env.DROPBOX_APP_SECRET;
const DROPBOX_ACCESS_TOKEN = process.env.DROPBOX_ACCESS_TOKEN;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

async function getDropboxAccessToken() {
  const response = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id: DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
    }),
  });
  const data = await response.json();
  if (!data.access_token) throw new Error(data.error_description || 'Failed to get access token');
  return data.access_token;
}

app.post('/webhook', async (req, res) => {
  const { order_id, agent_email, property_address, package_type, services_a_la_cart } = req.body;

  if (!order_id || !agent_email || !property_address || !package_type) {
    return res.status(400).json({
      error: 'Missing required fields: order_id, agent_email, property_address, package_type',
    });
  }

  const has_virtual_staging = Array.isArray(services_a_la_cart) && services_a_la_cart.includes('VIRTUAL STAGING');
  const has_virtual_cleaning = Array.isArray(services_a_la_cart) && services_a_la_cart.includes('VIRTUAL CLEANING');

  const { error } = await supabase
    .from('listings')
    .insert({ order_id, agent_email, property_address, package_type, has_virtual_staging, has_virtual_cleaning });

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

app.post('/upload-photo', upload.single('photo'), async (req, res) => {
  const { dropbox_folder_path } = req.body;
  const file = req.file;

  if (!file || !dropbox_folder_path) {
    return res.status(400).json({ success: false, error: 'Missing photo file or dropbox_folder_path' });
  }

  try {
    const accessToken = await getDropboxAccessToken();
    const dropboxPath = `${dropbox_folder_path}/${file.originalname}`;

    const uploadResponse = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: dropboxPath,
          mode: 'add',
          autorename: true,
          mute: false,
        }),
      },
      body: file.buffer,
    });

    const result = await uploadResponse.json();
    if (result.error) {
      console.error('[Upload] Dropbox error:', result.error);
      return res.status(500).json({ success: false, error: result.error_summary || 'Upload failed' });
    }

    console.log(`[Upload] Uploaded ${file.originalname} → ${result.path_display}`);
    return res.status(200).json({ success: true, path: result.path_display });
  } catch (err) {
    console.error('[Upload] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
