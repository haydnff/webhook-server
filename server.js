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
  // Log condensed version only to avoid rate limiting
  console.log('[Tonomo Webhook] Received order:', req.body?.orderId, '| status:', req.body?.orderStatus, '| email:', req.body?.email);

  const body = req.body;

  // Core fields
  const orderId = body.orderId || body.invoiceId;
  const agentEmail = body.email || body.listingAgents?.[0]?.email;
  const propertyAddress = body.property_address?.formatted_address;
  const orderStatus = body.orderStatus;

  if (!orderId || !agentEmail || !propertyAddress) {
    console.error('[Tonomo Webhook] Missing required fields:', { orderId, agentEmail, propertyAddress });
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Parse services ordered
  const servicesOrdered = body.services_a_la_cart || [];
  const hasVirtualStaging = servicesOrdered.includes('Virtual Staging');
  const hasVirtualCleaning = servicesOrdered.includes('Virtual Cleaning');
  const hasVirtualTwilight = servicesOrdered.includes('Virtual Twilight');
  const hasVideo = servicesOrdered.includes('Photo to Video');

  // Helper to parse photo count from tier name like "25 Photos" or "3 Photos"
  function parseTierCount(name) {
    if (!name) return null;
    const match = name.match(/^(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  // Parse limits from service_custom_tiers
  const tiers = body.service_custom_tiers || [];
  let photoLimit = 25;
  let virtualStagingLimit = null;
  let virtualCleaningLimit = null;
  let virtualTwilightLimit = null;
  let videoPhotoLimit = 20;
  let packageType = 'Standard';

  for (const tier of tiers) {
    const name = tier.serviceName;
    const selectedName = tier.selected?.name;
    const count = parseTierCount(selectedName);

    if (name === 'Listing Photos') {
      if (count) photoLimit = count;
      packageType = selectedName || 'Standard';
    } else if (name === 'Virtual Staging' && count) {
      virtualStagingLimit = count;
    } else if (name === 'Virtual Cleaning' && count) {
      virtualCleaningLimit = count;
    } else if (name === 'Virtual Twilight' && count) {
      virtualTwilightLimit = count;
    } else if (name === 'Photo to Video' && count) {
      videoPhotoLimit = count;
    }
  }

  // Parse collaborator email from customQuestions
  const customQuestions = body.customQuestions || [];
  const collabQuestion = customQuestions.find(q => q.label === 'Collaborator Email');
  const collaboratorEmail = collabQuestion?.value?.trim() || null;

  // Build Dropbox folder path
  const dropboxFolderPath = `/Listy/${agentEmail}/${propertyAddress.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-')}-${orderId}`;

  console.log(`[Tonomo Webhook] Parsed: photos=${photoLimit}, staging=${virtualStagingLimit}, cleaning=${virtualCleaningLimit}, twilight=${virtualTwilightLimit}, video=${hasVideo}, collaborator=${collaboratorEmail}`);

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const listingData = {
      order_id: orderId,
      agent_email: agentEmail,
      property_address: propertyAddress,
      package_type: packageType,
      photo_limit: photoLimit,
      status: 'pending',
      dropbox_folder_path: dropboxFolderPath,
      has_virtual_staging: hasVirtualStaging,
      has_virtual_cleaning: hasVirtualCleaning,
      has_virtual_twilight: hasVirtualTwilight,
      has_video: hasVideo,
      virtual_staging_limit: virtualStagingLimit,
      virtual_cleaning_limit: virtualCleaningLimit,
      virtual_twilight_limit: virtualTwilightLimit,
      video_photo_limit: videoPhotoLimit,
      virtual_staging_used: 0,
      virtual_cleaning_used: 0,
      virtual_twilight_used: 0,
      video_photos_used: 0,
      photos_uploaded: false,
      collaborator_email: collaboratorEmail || null
    };

    const { error } = await supabase
      .from('listings')
      .upsert(listingData, { onConflict: 'order_id' });
    if (error) throw error;
    console.log(`[Tonomo Webhook] Upserted listing for order ${orderId}`);

    // Send welcome email to agent
    try {
      const welcomeEmailHtml = `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td>
        <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#ffffff;line-height:1px;">Your listing is ready — open Listy to start shooting.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
        </td></tr>
        <tr><td align="center" style="padding:48px 24px;">
        <table cellpadding="0" cellspacing="0" border="0" style="max-width:400px;width:100%;">
        <tr><td align="center" style="padding-bottom:32px;">
        <div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#0A84FF,#BF5AF2);background-color:#0A84FF;display:inline-block;line-height:56px;text-align:center;font-size:24px;font-weight:700;color:#ffffff;">L</div>
        </td></tr>
        <tr><td align="center" style="padding-bottom:10px;">
        <p style="margin:0;font-size:23px;font-weight:700;color:#000000;letter-spacing:-0.4px;text-align:center;">Hi ${agentEmail.split('@')[0]}, ${propertyAddress} is ready to shoot</p>
        </td></tr>
        <tr><td align="center" style="padding-bottom:36px;">
        <p style="margin:0;font-size:14px;color:#6C6C70;line-height:1.6;text-align:center;">Open Listy to get started.</p>
        </td></tr>
        <tr><td align="center" style="padding-bottom:16px;">
        <table cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="background:linear-gradient(135deg,#0A84FF,#BF5AF2);background-color:#0A84FF;border-radius:14px;">
        <a href="https://listy.live/open" target="_blank" style="display:inline-block;padding:14px 48px;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;">Open Listy</a>
        </td></tr>
        </table>
        </td></tr>
        <tr><td align="center" style="padding-bottom:32px;">
        <p style="margin:0;font-size:12px;color:#8E8E93;text-align:center;">Your listing is waiting in the app</p>
        </td></tr>
        <tr><td style="padding-bottom:20px;">
        <div style="height:1px;background-color:#E5E5EA;"></div>
        </td></tr>
        <tr><td style="padding-bottom:24px;">
        <p style="margin:0;font-size:12px;color:#8E8E93;line-height:1.6;text-align:center;">Questions? <a href="mailto:hello@listy.live" style="color:#0A84FF;text-decoration:none;">hello@listy.live</a></p>
        </td></tr>
        <tr><td align="center">
        <a href="https://listy.live" target="_blank" style="font-size:13px;font-weight:600;text-decoration:none;background:linear-gradient(135deg,#0A84FF,#BF5AF2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:#0A84FF;">Listy</a>
        </td></tr>
        </table></td></tr>
        </table>
      `;

      const welcomeRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Listy <noreply@listy.live>',
          to: agentEmail,
          subject: `${propertyAddress} is ready to shoot`,
          html: welcomeEmailHtml,
        }),
      });

      if (welcomeRes.ok) {
        console.log(`[Tonomo Webhook] Welcome email sent to ${agentEmail}`);
      } else {
        const err = await welcomeRes.json();
        console.error('[Tonomo Webhook] Welcome email failed:', err);
      }
    } catch (emailErr) {
      console.error('[Tonomo Webhook] Welcome email error:', emailErr.message);
    }

    // Send collaborator invite if email present
    if (collaboratorEmail) {
      try {
        const { signInWithOTP } = await import('@supabase/supabase-js');
        await supabase.auth.admin.generateLink({
          type: 'magiclink',
          email: collaboratorEmail
        });
        console.log(`[Tonomo Webhook] Sent collaborator invite to ${collaboratorEmail}`);
      } catch (inviteErr) {
        console.error('[Tonomo Webhook] Collaborator invite failed:', inviteErr.message);
      }
    }

    return res.status(200).json({ success: true, orderId });
  } catch (err) {
    console.error('[Tonomo Webhook] Database error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
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

  const updateData = { status: 'completed', completed_at: new Date().toISOString() };
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

app.post('/send-collaborator-invite', async (req, res) => {
  const { collaborator_email, property_address, agent_email } = req.body;

  if (!collaborator_email || !property_address) {
    return res.status(400).json({ error: 'Missing collaborator_email or property_address' });
  }

  console.log(`[Collaborator] Sending invite to ${collaborator_email} for ${property_address}`);

  const emailHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td>
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#ffffff;line-height:1px;">Your listing is ready — open Listy to start shooting.&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
    </td></tr>
    <tr><td align="center" style="padding:48px 24px;">
    <table cellpadding="0" cellspacing="0" border="0" style="max-width:400px;width:100%;">

    <tr><td align="center" style="padding-bottom:32px;">
    <div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#0A84FF,#BF5AF2);background-color:#0A84FF;display:inline-block;line-height:56px;text-align:center;font-size:24px;font-weight:700;color:#ffffff;">L</div>
    </td></tr>

    <tr><td align="center" style="padding-bottom:10px;">
    <p style="margin:0;font-size:23px;font-weight:700;color:#000000;letter-spacing:-0.4px;text-align:center;">Your listing is ready</p>
    </td></tr>

    <tr><td align="center" style="padding-bottom:36px;">
    <p style="margin:0;font-size:14px;color:#6C6C70;line-height:1.6;text-align:center;">${property_address}<br>Open Listy to start shooting.</p>
    </td></tr>

    <tr><td align="center" style="padding-bottom:16px;">
    <table cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="background:linear-gradient(135deg,#0A84FF,#BF5AF2);background-color:#0A84FF;border-radius:14px;">
    <a href="listy://" target="_blank" style="display:inline-block;padding:14px 48px;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;">Open Listy</a>
    </td></tr>
    </table>
    </td></tr>

    <tr><td align="center" style="padding-bottom:32px;">
    <p style="margin:0;font-size:12px;color:#8E8E93;text-align:center;">Your listing is waiting in the app</p>
    </td></tr>

    <tr><td style="padding-bottom:20px;">
    <div style="height:1px;background-color:#E5E5EA;"></div>
    </td></tr>

    <tr><td style="padding-bottom:24px;">
    <p style="margin:0;font-size:12px;color:#8E8E93;line-height:1.6;text-align:center;">Not you? Ignore this email — your account is safe.<br>Questions? <a href="mailto:hello@listy.live" style="color:#0A84FF;text-decoration:none;">hello@listy.live</a></p>
    </td></tr>

    <tr><td align="center">
    <a href="https://listy.live" target="_blank" style="font-size:13px;font-weight:600;text-decoration:none;background:linear-gradient(135deg,#0A84FF,#BF5AF2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;color:#0A84FF;">Listy</a>
    </td></tr>

    </table></td></tr>
    </table>
  `;

  try {
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Listy <noreply@listy.live>',
        to: collaborator_email,
        subject: `You've been invited to collaborate — ${property_address}`,
        html: emailHtml,
      }),
    });

    const emailData = await emailResponse.json();
    if (!emailResponse.ok) {
      console.error('[Collaborator] Resend error:', emailData);
      return res.status(500).json({ error: 'Failed to send invite email' });
    }

    console.log(`[Collaborator] Invite sent to ${collaborator_email} for ${property_address}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[Collaborator] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
