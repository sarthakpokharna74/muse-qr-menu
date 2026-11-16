const os = require('node:os');

function getLanIp() {
  const nets = os.networkInterfaces();
  // Prefer Wi-Fi or Ethernet
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        if (!name.includes('vEthernet') && !name.includes('Virtual') && !name.includes('Loopback')) {
          return net.address;
        }
      }
    }
  }
  // Fallback to any non-internal IPv4
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

module.exports = {
  getLanIp
};

