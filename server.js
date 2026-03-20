require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
