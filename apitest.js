const axios = require('axios');

const accessToken = 'aaps-f286719b8dcde96f';
const lastSiteChangeTreatment = '2026-03-12T08:46:57.000Z';

function getDeviceStatusBaseline(jwt) {
  return axios(`https://ns-drop-gd.fly.dev/api/v3/devicestatus?lastSiteChange=${lastSiteChangeTreatment}&sort$desc=created_at&limit=1`,
    {
      headers: {
        'Authorization': `Bearer ${jwt}`
      }
    });
}

function getPreviousDeviceStatus(jwt) {
  return axios(`https://ns-drop-gd.fly.dev/api/v3/devicestatus?lastSiteChange=${lastSiteChangeTreatment}&sort=created_at&limit=1`,
    {
      headers: {
        'Authorization': `Bearer ${jwt}`
      }
    });
}

function getNewToken() {
  return axios.get(`https://ns-drop-gd.fly.dev/api/v2/authorization/request/${accessToken}`)
    .then(res => {
      const jwt = res.data.token;
      return jwt;
    });
}

getNewToken()
  .then(getDeviceStatusBaseline)
  .then(res => {
    console.log(res.data);
  })

getNewToken()
  .then(getPreviousDeviceStatus)
  .then(res => {
    console.log(res.data);
  });

