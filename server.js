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

async function uploadFileToDropbox(accessToken, dropboxPath, fileBuffer, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: dropboxPath,
          mode: 'add',
          autorename: true,
        }),
      },
      body: fileBuffer,
    });
    const result = await response.json();
    if (!result.error) return result;
    if (result.error?.reason?.['.tag'] === 'too_many_write_operations' && attempt < retries) {
      const waitMs = ((result.error?.retry_after || 1) * 1000) + 500;
      console.log(`[Upload] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    } else {
      console.error(`[Upload] Failed after ${attempt} attempts:`, result.error_summary);
      return result;
    }
  }
}

app.post('/upload-photo', upload.array('photos'), async (req, res) => {
  const { dropbox_folder_path, addon } = req.body;
  const files = req.files;

  if (!files || files.length === 0 || !dropbox_folder_path) {
    return res.status(400).json({ success: false, error: 'Missing photos or dropbox_folder_path' });
  }

  try {
    const accessToken = await getDropboxAccessToken();

    // Determine single destination folder based on addon
    let folder;
    switch (addon) {
      case 'stage': folder = `${dropbox_folder_path}/upload-stage`; break;
      case 'clean': folder = `${dropbox_folder_path}/upload-clean`; break;
      case 'cleanThenStage': folder = `${dropbox_folder_path}/upload-clean-stage`; break;
      default: folder = `${dropbox_folder_path}/upload-raw`; break;
    }

    // Upload files sequentially with 300ms gap
    const results = [];
    for (const file of files) {
      const dropboxPath = `${folder}/${file.originalname}`;
      const result = await uploadFileToDropbox(accessToken, dropboxPath, file.buffer);
      results.push(result);
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    const errors = results.filter(r => r && r.error);
    if (errors.length > 0) {
      console.error('[Upload] Some uploads failed:', errors);
    }

    const uploaded = results.length - errors.length;
    console.log(`[Upload] ${uploaded}/${results.length} files uploaded (addon: ${addon || 'none'})`);
    return res.status(200).json({ success: true, uploaded });
  } catch (err) {
    console.error('[Upload] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/tonomo-completed', async (req, res) => {
  const payload = req.body;
  console.log('[Tonomo Completed] Payload:', JSON.stringify(payload));

  const orderId = payload.order_id || payload.orderId || payload.id;

  if (!orderId) {
    console.error('[Tonomo Completed] No order ID found in payload');
    return res.status(400).json({ error: 'No order ID found' });
  }

  const deliveryLink = payload.delivery_link || payload.deliveryLink || null;

  const updateData = { status: 'completed' };
  if (deliveryLink) updateData.delivery_link = deliveryLink;

  const { error } = await supabase
    .from('listings')
    .update(updateData)
    .eq('order_id', orderId);

  if (error) {
    console.error('[Tonomo Completed] Supabase update error:', error.message);
    return res.status(500).json({ error: 'Failed to update listing' });
  }

  console.log(`[Tonomo Completed] Order ${orderId} marked as completed`);
  return res.status(200).json({ success: true, order_id: orderId });
});

// Dropbox webhook verification — Dropbox sends a GET request first to confirm the server is real
app.get('/dropbox-webhook', (req, res) => {
  const challenge = req.query.challenge;
  console.log('[Dropbox Webhook] Verification challenge received:', challenge);
  res.set('Content-Type', 'text/plain');
  res.set('X-Content-Type-Options', 'nosniff');
  res.status(200).send(challenge);
});

// Dropbox webhook notification — fires when files change in Dropbox
app.post('/dropbox-webhook', async (req, res) => {
  console.log('[Dropbox Webhook] Notification received:', JSON.stringify(req.body));

  // Respond immediately — Dropbox requires a fast response or it retries
  res.status(200).json({ success: true });

  // Process in background
  try {
    const accessToken = await getDropboxAccessToken();

    // Get list of changed paths from the webhook payload
    const accounts = req.body?.list_folder?.accounts || [];
    if (accounts.length === 0) {
      console.log('[Dropbox Webhook] No accounts in payload, skipping');
      return;
    }

    // For each changed account, list recent changes
    for (const accountId of accounts) {
      const changesResponse = await fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cursor: accountId }),
      });

      const changes = await changesResponse.json();
      console.log('[Dropbox Webhook] Changes:', JSON.stringify(changes));

      // Look for files landing in a PHOTOS delivery folder
      const entries = changes?.entries || [];
      for (const entry of entries) {
        const path = entry?.path_lower || '';

        // Check if file landed in a PHOTOS delivery folder
        // Expected path pattern: /tonomo/[agent]/[address]/photos/[file]
        if (path.includes('/photos/') && !path.includes('/listy-')) {
          console.log('[Dropbox Webhook] Delivery file detected:', path);

          // Extract the listing folder path — everything up to /photos/
          const folderPath = path.substring(0, path.toLowerCase().indexOf('/photos/'));

          if (!folderPath) continue;

          // Find the listing in Supabase by matching dropbox_folder_path
          const { data: listings, error } = await supabase
            .from('listings')
            .select('*')
            .ilike('dropbox_folder_path', folderPath)
            .eq('photos_uploaded', true)
            .neq('status', 'completed');

          if (error) {
            console.error('[Dropbox Webhook] Supabase query error:', error.message);
            continue;
          }

          if (!listings || listings.length === 0) {
            console.log('[Dropbox Webhook] No matching listing found for path:', folderPath);
            continue;
          }

          const listing = listings[0];
          console.log(`[Dropbox Webhook] Marking listing ${listing.id} (order ${listing.order_id}) as completed`);

          const { error: updateError } = await supabase
            .from('listings')
            .update({ status: 'completed' })
            .eq('id', listing.id);

          if (updateError) {
            console.error('[Dropbox Webhook] Failed to update status:', updateError.message);
          } else {
            console.log(`[Dropbox Webhook] ✅ Order ${listing.order_id} marked as completed`);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Dropbox Webhook] Processing error:', err.message);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
