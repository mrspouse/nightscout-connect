const axios = require('axios');
const accessToken = 'aaps-f286719b8dcde96f';
const lastModified = 1613057520148;
axios.get(`https://ns-drop-gd.fly.dev/api/v2/authorization/request/${accessToken}`)
  .then(res => {
    const jwt = res.data.token;
    return axios(`https://ns-drop-gd.fly.dev/api/v3/devicestatus?lastSiteChange=2026-03-12T08:46:57.000Z&sort$desc=created_at&limit=1`,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`
        }
      });
  })
  .then(res => {
    console.log(res.data);
  });