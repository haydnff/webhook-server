require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json({ limit: '20mb' }));

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

app.post('/dropbox-token', async (req, res) => {
  try {
    const credentials = Buffer.from(
      `${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`
    ).toString('base64');

    const response = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[Dropbox Token] Error:', data);
      return res.status(500).json({ error: 'Failed to get Dropbox token' });
    }

    console.log('[Dropbox Token] Token refreshed successfully');
    return res.json({ access_token: data.access_token });
  } catch (err) {
    console.error('[Dropbox Token] Server error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.post('/webhook', async (req, res) => {
  // Log condensed version only to avoid rate limiting
  console.log('[Tonomo Webhook] Received order:', req.body?.orderId, '| status:', req.body?.orderStatus, '| email:', req.body?.email);

  const body = req.body;

  // Core fields
  const orderId = body.orderId || body.invoiceId;
  const agentEmail = body.email || body.listingAgents?.[0]?.email;
  const clientFullName = body.client_full_name || '';
  const propertyAddress = body.property_address?.formatted_address;
  const orderStatus = body.orderStatus;

  if (orderStatus === 'cancelled') {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { error } = await supabase
      .from('listings')
      .delete()
      .eq('order_id', orderId);
    if (error) {
      console.error('[Tonomo Webhook] Failed to delete cancelled listing:', error);
    } else {
      console.log(`[Tonomo Webhook] Deleted cancelled listing for order ${orderId}`);
    }
    return res.status(200).json({ received: true });
  }

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
      client_full_name: clientFullName,
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

    const { data: existingListing } = await supabase
      .from('listings')
      .select('id, photos_uploaded, status')
      .eq('order_id', orderId)
      .maybeSingle();

    // Don't overwrite upload state if photos have already been uploaded
    if (existingListing?.photos_uploaded === true) {
      delete listingData.photos_uploaded;
      delete listingData.status;
      delete listingData.virtual_staging_used;
      delete listingData.virtual_cleaning_used;
      delete listingData.virtual_twilight_used;
      delete listingData.video_photos_used;
      console.log(`[Tonomo Webhook] Preserving upload state for order ${orderId} — photos already uploaded`);
    }

    const { error } = await supabase
      .from('listings')
      .upsert(listingData, { onConflict: 'order_id' });
    if (error) throw error;

    const isNewListing = !existingListing;
    console.log(`[Tonomo Webhook] Upserted listing for order ${orderId} (${isNewListing ? 'new' : 'update'})`);

    // Atomic claim — only one request can win per order_id
    console.log(`[Tonomo Webhook] Status check: "${listingData.status}" === 'pending': ${listingData.status === 'pending'}`);
    if (listingData.status === 'pending') {
      const { data: claimed, error: claimError } = await supabase
        .from('listings')
        .update({ welcome_email_sent: true })
        .eq('order_id', orderId)
        .eq('welcome_email_sent', false)
        .select();

      if (claimError) {
        console.error('[Tonomo Webhook] Claim error:', JSON.stringify(claimError));
      } else if (claimed && claimed.length > 0) {
        try {
          const welcomeEmailHtml = `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <tr><td>
            <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#ffffff;line-height:1px;">is ready to shoot&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
            </td></tr>
            <tr><td align="center" style="padding:48px 24px;">
            <table cellpadding="0" cellspacing="0" border="0" style="max-width:400px;width:100%;">
            <tr><td align="center" style="padding-bottom:32px;">
            <div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#0A84FF,#BF5AF2);background-color:#0A84FF;display:inline-block;line-height:56px;text-align:center;font-size:24px;font-weight:700;color:#ffffff;">L</div>
            </td></tr>
            <tr><td align="center" style="padding-bottom:10px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#000000;letter-spacing:-0.4px;text-align:center;line-height:2.2;">Listy<br>${propertyAddress.split(',')[0]}<br>is ready to shoot</p>
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
              subject: `${propertyAddress.split(',')[0]}`,
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
      } else {
        console.log(`[Tonomo Webhook] Email already sent for order ${orderId}, skipping`);
      }
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
  console.log('[Dropbox Webhook] Notification received');

  // Respond immediately — Dropbox requires a fast response or it retries
  res.status(200).json({ success: true });

  // Process in background
  try {
    const accessToken = await getDropboxAccessToken();

    console.log('[Dropbox Webhook] Checking all pending listings...');

    const { data: pendingListings, error: queryError } = await supabase
      .from('listings')
      .select('*')
      .eq('photos_uploaded', true)
      .neq('status', 'completed')
      .not('dropbox_autohdr_path', 'is', null);

    if (queryError) {
      console.error('[Dropbox Webhook] Supabase query error:', queryError.message);
      return;
    }

    if (!pendingListings || pendingListings.length === 0) {
      console.log('[Dropbox Webhook] No pending listings found');
      return;
    }

    console.log(`[Dropbox Webhook] Found ${pendingListings.length} pending listing(s) — checking AutoHDR...`);

    for (const listing of pendingListings) {
      await checkAutoHDRCompletion(listing, accessToken);
    }
  } catch (err) {
    console.error('[Dropbox Webhook] Processing error:', err.message);
  }
});

// MARK: - AutoHDR Completion Pipeline

async function checkAutoHDRCompletion(listing, accessToken) {
  // Re-fetch the listing so we have the freshest completion flags — this
  // ensures a second concurrent webhook sees any in-flight updates from a
  // parallel invocation and skips services that are already marked complete.
  const { data: fresh, error: freshError } = await supabase
    .from('listings')
    .select('*')
    .eq('id', listing.id)
    .single();
  if (!freshError && fresh) {
    listing = fresh;
  }

  const basePath = listing.dropbox_autohdr_path; // e.g. /AutoHDR/123 Main St
  if (!basePath) return;

  // Extract address from basePath for delivery folder
  const address = basePath.replace('/AutoHDR/', '');
  const deliveryBase = `/Clients/${address}`;

  // Determine which service folders to check based on what was uploaded
  const services = ['standard'];
  if (listing.virtual_staging_used > 0) services.push('staging');
  if (listing.virtual_cleaning_used > 0) services.push('cleaning');
  if (listing.clean_stage_used > 0) services.push('clean-stage');
  if (listing.virtual_twilight_used > 0) services.push('twilight');
  if (listing.video_photos_used > 0) services.push('video');

  for (const service of services) {
    const finalPath = `${basePath}/${service}/04-FINAL-Photos`;
    const completionKey = service.replace('-', '_'); // clean-stage → clean_stage
    const completionField = `autohdr_complete_${completionKey}`;

    // Skip if already marked complete
    if (listing[completionField] === true) continue;

    try {
      // Check if 04-FINAL-Photos folder exists and has files
      const listResponse = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ path: finalPath, limit: 2000 }),
      });

      const listData = await listResponse.json();
      if (listData.error) continue; // Folder doesn't exist yet

      const files = (listData.entries || []).filter(e => e['.tag'] === 'file');
      if (files.length === 0) continue;

      // Determine expected count
      let expectedCount = 1;
      if (service === 'standard') expectedCount = listing.photos_taken || 1;
      if (service === 'staging') expectedCount = listing.virtual_staging_used || 1;
      if (service === 'cleaning') expectedCount = listing.virtual_cleaning_used || 1;
      if (service === 'clean-stage') expectedCount = listing.clean_stage_used || 1;
      if (service === 'twilight') expectedCount = listing.virtual_twilight_used || 1;
      if (service === 'video') expectedCount = listing.video_photos_used || 1;

      console.log(`[AutoHDR] ${listing.order_id} | ${service} | ${files.length}/${expectedCount} files`);

      if (files.length < expectedCount) continue;

      // Service complete — route files to delivery folders
      console.log(`[AutoHDR] ✅ ${listing.order_id} | ${service} complete — routing ${files.length} files`);

      // Mark complete in Supabase BEFORE routing, so a second concurrent
      // webhook fetches fresh state and skips via the guard at the top of
      // this loop (line 526: `if (listing[completionField] === true) continue;`).
      const updateData = {};
      updateData[completionField] = true;

      const { error: updateError } = await supabase
        .from('listings')
        .update(updateData)
        .eq('id', listing.id);

      if (updateError) {
        console.error(`[AutoHDR] Failed to update ${completionField}:`, updateError.message);
      } else {
        listing[completionField] = true;
      }

      const tonomoAddress = listing.property_address || address;
      await routeCompletedFiles(service, files, basePath, deliveryBase, accessToken, listing.client_full_name, tonomoAddress, listing);

    } catch (err) {
      console.error(`[AutoHDR] Error checking ${service} for listing ${listing.id}:`, err.message);
    }
  }

  await checkAllServicesComplete(listing);
}

function extractRoomType(filename) {
  // Filename format: UUID_roomtype_bracket.jpg
  // e.g. 87A3EE28-6B93-46D9-A63D-EEF1E6DE6F51_nursery_under.jpg
  const parts = filename.replace('.jpg', '').split('_');
  // UUID has hyphens so it's parts[0], bracket is last part, room is everything in between
  if (parts.length >= 3) {
    const roomParts = parts.slice(1, parts.length - 1);
    const room = roomParts.join('-');
    return room || null;
  }
  return null;
}

function extractStagingInfo(filename) {
  // New filename format: UUID_roomtype_style_bracket.{jpg|heic}
  // e.g. 87A3EE28-6B93-46D9-A63D-EEF1E6DE6F51_bedroom_modern_under.heic
  const base = filename.replace(/\.(jpg|jpeg|heic|heif)$/i, '');
  const parts = base.split('_');
  if (parts.length >= 4) {
    const bracket = parts[parts.length - 1];
    const style = parts[parts.length - 2];
    const roomParts = parts.slice(1, parts.length - 2);
    const room = roomParts.join('-');
    return { room, style, bracket };
  }
  return null;
}

// Maps Listy room strings (from filename slugs) to Decor8 AI room_type enums
const DECOR8_ROOM_TYPE_MAP = {
  'living-room': 'livingroom',
  'family-room': 'livingroom',
  'bedroom': 'bedroom',
  'kids-room': 'kidsroom',
  'home-office': 'office',
  'study-room': 'office',
  'dining-room': 'diningroom',
};

async function getDropboxTempLink(accessToken, filePath) {
  const response = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ path: filePath }),
  });
  const result = await response.json();
  if (result.error) {
    throw new Error(`Dropbox temp link failed: ${result.error_summary || 'unknown'}`);
  }
  return result.link;
}

async function processFileWithDecor8(file, roomType, accessToken, destFolder) {
  const decor8Room = DECOR8_ROOM_TYPE_MAP[roomType] || 'livingroom';
  console.log(`[Decor8] Staging ${file.name} as ${decor8Room}`);

  const tempLink = await getDropboxTempLink(accessToken, file.path_lower);

  const stageResponse = await fetch('https://api.decor8.ai/generate_designs_for_room', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DECOR8_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_image_url: tempLink,
      room_type: decor8Room,
      design_style: 'MODERN',
      num_images: 1,
    }),
  });

  const stageData = await stageResponse.json();
  const stagedUrl = stageData?.info?.images?.[0]?.url;
  if (!stagedUrl) {
    throw new Error(`Decor8 returned no image: ${JSON.stringify(stageData).slice(0, 300)}`);
  }

  const imageResponse = await fetch(stagedUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to download staged image: ${imageResponse.status}`);
  }
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

  const destPath = `${destFolder}/${file.name}`;
  const uploadResult = await uploadFileToDropbox(accessToken, destPath, imageBuffer);
  if (uploadResult?.error) {
    throw new Error(`Upload to ${destPath} failed: ${uploadResult.error_summary}`);
  }
  console.log(`[Decor8] Staged ${file.name} → ${destFolder}`);
}

async function processFileWithDecor8Cleanse(file, accessToken, destFolder) {
  console.log(`[Cleaning] Removing objects from ${file.name}`);

  const tempLink = await getDropboxTempLink(accessToken, file.path_lower);

  const cleanseResponse = await fetch('https://api.decor8.ai/remove_objects_from_room', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DECOR8_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_image_url: tempLink,
      room_type: 'livingroom',
    }),
  });

  const cleanseData = await cleanseResponse.json();
  const cleansedUrl = cleanseData?.info?.url;
  if (!cleansedUrl) {
    throw new Error(`Decor8 cleanse returned no image: ${JSON.stringify(cleanseData).slice(0, 300)}`);
  }

  const imageResponse = await fetch(cleansedUrl);
  if (!imageResponse.ok) {
    throw new Error(`Failed to download cleansed image: ${imageResponse.status}`);
  }
  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

  const destPath = `${destFolder}/${file.name}`;
  const uploadResult = await uploadFileToDropbox(accessToken, destPath, imageBuffer);
  if (uploadResult?.error) {
    throw new Error(`Upload to ${destPath} failed: ${uploadResult.error_summary}`);
  }
  console.log(`[Cleaning] Cleaned ${file.name} → Virtual Cleaning folder`);
}

// Route completed files from 04-FINAL-Photos to client delivery folders
async function routeCompletedFiles(service, files, basePath, deliveryBase, accessToken, clientName, propertyAddress, listing = null) {
  const tonomoBase = `/Tonomo/${clientName || 'Unknown'}/${propertyAddress}`;
  const copyTargets = [];

  switch (service) {
    case 'standard':
      copyTargets.push(`${tonomoBase}/Listing Photos`);
      break;

    case 'staging': {
      console.log(`[Route] Staging — clientName: "${listing?.client_full_name}" | address: "${propertyAddress}"`);
      console.log(`[Route] Tonomo base path: ${tonomoBase}`);
      console.log(`[Route] Files to copy: ${files.length}`);

      // 1. Copy originals to Listing Photos via the shared copy loop below
      copyTargets.push(`${tonomoBase}/Listing Photos`);

      // 2. Build staging info map (room + style) from filenames
      const stagingInfoMap = {};
      for (const file of files) {
        const info = extractStagingInfo(file.name);
        if (info) {
          stagingInfoMap[file.name] = info;
          console.log(`[Staging] ${file.name} → room: ${info.room} | style: ${info.style}`);
        }
      }

      // 3. Process each file with Decor8 and deliver to Virtual Staging
      const stagingFolder = `${tonomoBase}/Virtual Staging`;
      for (const file of files) {
        const info = stagingInfoMap[file.name];
        const room = info?.room || 'living-room';
        try {
          await processFileWithDecor8(file, room, accessToken, stagingFolder);
        } catch (err) {
          console.error(`[Decor8] Failed for ${file.name}: ${err.message}. Falling back to copy.`);
          try {
            const destPath = `${stagingFolder}/${file.name}`;
            const copyResponse = await fetch('https://api.dropboxapi.com/2/files/copy_v2', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                from_path: file.path_lower,
                to_path: destPath,
                autorename: true,
              }),
            });
            const copyResult = await copyResponse.json();
            if (copyResult.error) {
              console.error(`[Decor8] Fallback copy failed: ${copyResult.error_summary}`);
            } else {
              console.log(`[Decor8] Fallback: copied original ${file.name} → ${stagingFolder}`);
            }
          } catch (fallbackErr) {
            console.error(`[Decor8] Fallback copy error: ${fallbackErr.message}`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      break;
    }

    case 'cleaning': {
      console.log(`[Route] Cleaning — clientName: "${listing?.client_full_name}" | address: "${propertyAddress}"`);
      console.log(`[Route] Tonomo base path: ${tonomoBase}`);
      console.log(`[Route] Files to copy: ${files.length}`);

      // 1. Copy originals to Listing Photos via the shared copy loop below
      copyTargets.push(`${tonomoBase}/Listing Photos`);

      // 2. Process each file with Decor8 cleanse and deliver to Virtual Cleaning
      const cleaningFolder = `${tonomoBase}/Virtual Cleaning`;
      for (const file of files) {
        try {
          await processFileWithDecor8Cleanse(file, accessToken, cleaningFolder);
        } catch (err) {
          console.error(`[Decor8] Cleanse failed for ${file.name}: ${err.message}. Falling back to copy.`);
          try {
            const destPath = `${cleaningFolder}/${file.name}`;
            const copyResponse = await fetch('https://api.dropboxapi.com/2/files/copy_v2', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                from_path: file.path_lower,
                to_path: destPath,
                autorename: true,
              }),
            });
            const copyResult = await copyResponse.json();
            if (copyResult.error) {
              console.error(`[Decor8] Cleanse fallback copy failed: ${copyResult.error_summary}`);
            } else {
              console.log(`[Decor8] Cleanse fallback: copied original ${file.name} → ${cleaningFolder}`);
            }
          } catch (fallbackErr) {
            console.error(`[Decor8] Cleanse fallback copy error: ${fallbackErr.message}`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      break;
    }

    case 'clean-stage':
      copyTargets.push(`${tonomoBase}/Virtual Cleaning`);
      break;

    case 'twilight':
      copyTargets.push(`${tonomoBase}/Listing Photos`);
      copyTargets.push(`${tonomoBase}/Virtual Twilight`);
      break;

    case 'video':
      copyTargets.push(`${tonomoBase}/Listing Photos`);
      copyTargets.push(`${tonomoBase}/Photo to Video`);
      break;
  }

  for (const target of copyTargets) {
    for (const file of files) {
      const filename = file.name;
      const destPath = `${target}/${filename}`;

      console.log(`[Route] Copying ${filename} from ${file.path_lower} → ${destPath}`);

      try {
        const copyResponse = await fetch('https://api.dropboxapi.com/2/files/copy_v2', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from_path: file.path_lower,
            to_path: destPath,
            autorename: true,
          }),
        });

        const copyResult = await copyResponse.json();
        if (copyResult.error) {
          console.error(`[Route] Copy FAILED: ${JSON.stringify(copyResult.error)}`);
        } else {
          console.log(`[Route] Copy SUCCESS → ${destPath}`);
        }

        // 200ms cooldown between copies
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        console.error(`[AutoHDR] Copy error: ${filename} → ${target}:`, err.message);
      }
    }
  }
}

async function checkAllServicesComplete(listing) {
  const { data: updated, error } = await supabase
    .from('listings')
    .select('*')
    .eq('id', listing.id)
    .single();

  if (error || !updated) return;

  const requiredServices = ['standard'];
  if (updated.virtual_staging_used > 0) requiredServices.push('staging');
  if (updated.virtual_cleaning_used > 0) requiredServices.push('cleaning');
  if (updated.clean_stage_used > 0) requiredServices.push('clean_stage');
  if (updated.virtual_twilight_used > 0) requiredServices.push('twilight');
  if (updated.video_photos_used > 0) requiredServices.push('video');

  const allComplete = requiredServices.every(s => updated[`autohdr_complete_${s}`] === true);

  if (allComplete) {
    console.log(`[AutoHDR] ✅✅ All services complete for ${updated.order_id} — marking completed`);

    const { error: statusError } = await supabase
      .from('listings')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', updated.id);

    if (statusError) {
      console.error('[AutoHDR] Failed to set completed:', statusError.message);
    }
  }
}

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

// AI Composition Coach — proxies image to Claude Haiku for real-time coaching
app.post('/ai-coach', async (req, res) => {
  try {
    const { imageBase64, roomType, pitchDegrees, rollDegrees, estimatedHeight } = req.body;
    console.log('[AI Coach] Request received — room:', roomType, '| pitch:', pitchDegrees, '| base64 length:', imageBase64?.length || 0);

    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing image data' });
    }

    const room = roomType || 'unknown room';
    const pitch = pitchDegrees ? `${parseFloat(pitchDegrees).toFixed(1)}°` : 'unknown';
    const roll = rollDegrees ? `${parseFloat(rollDegrees).toFixed(1)}°` : 'unknown';
    const height = estimatedHeight ? `${parseFloat(estimatedHeight).toFixed(1)} feet` : 'unknown';

    const roomHeightGuide = {
      kitchen: '5.0–5.5 feet (15–20 inches above countertop)',
      bathroom: '5.0–5.5 feet (above vanity height)',
      bedroom: '4.5–5.0 feet (15–20 inches above bed)',
      'living room': '3.5–4.5 feet (waist to chest height)',
      'dining room': '4.0–5.0 feet (slightly above table height)',
      exterior: '5.0–6.0 feet (standing chest height)',
    };

    const idealHeight = roomHeightGuide[room.toLowerCase()] || '4.0–5.5 feet (chest height)';

    const systemPrompt = `You are an expert real estate photography coach. You analyze camera position only — never lighting, never staging, never image quality.

You have access to:
- The live camera frame (with rule-of-thirds grid overlay)
- Room type: ${room}
- Camera pitch: ${pitch} (positive = tilted back, negative = tilted forward/down)
- Camera roll: ${roll}
- Estimated height: ${height}

IDEAL HEIGHT BY ROOM:
- Living room: 3.5–4.5 feet (waist to chest)
- Kitchen: 5.0–5.5 feet (15–20 inches above countertop)
- Bedroom: 4.5–5.0 feet (15–20 inches above bed)
- Bathroom: 5.0–5.5 feet (above vanity)
- Dining room: 4.0–5.0 feet (above table height)
- Exterior: 5.0–6.0 feet (chest height)

Respond with EXACTLY this format — 3 lines, no extra text, no intro, no summary:

HEIGHT: [one specific instruction about raising or lowering the camera, include inches if possible, or "✓ Good" if correct]
POSITION: [one instruction about moving left/right/back/forward or moving to a corner, or "✓ Good" if correct]
FRAMING: [one instruction about what is cut off or missing from the frame, or "✓ Good" if nothing is cut off]

EXAMPLES OF GOOD RESPONSES:
HEIGHT: Raise camera 8 inches — too much floor, not enough ceiling
POSITION: Move to the far corner — diagonal view makes the room look larger
FRAMING: Step back 2 feet — the left sofa arm is cut off

HEIGHT: ✓ Good
POSITION: Shift right 1 step — center the fireplace, it's the focal point
FRAMING: Step back 1 foot — refrigerator is cut off on the right

RULES:
- Never mention lighting, exposure, brightness, blur, or image quality
- Never use the word "consider" or "try" — give direct commands
- Never write more than 3 lines
- Never write an intro or conclusion
- Start each line with exactly HEIGHT:, POSITION:, or FRAMING:`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageBase64,
                },
              },
              {
                type: 'text',
                text: `Room type: ${room}\nCamera sensor data: pitch ${pitch}, roll ${roll}, estimated height ${height}\nGive me ONE composition adjustment directive now.`,
              },
            ],
          },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[AI Coach] Anthropic error status:', response.status);
      console.error('[AI Coach] Anthropic error body:', JSON.stringify(data));
      return res.status(500).json({ error: 'AI analysis failed' });
    }

    const suggestion = data.content?.[0]?.text?.trim();
    console.log(`[AI Coach] Room: ${room} | Height: ${height} | Pitch: ${pitch} | Suggestion: ${suggestion}`);
    return res.json({ suggestion });

  } catch (err) {
    console.error('[AI Coach] Error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
