export function summarizeIceServers(iceServers) {
  const summary = {
    stun: 0,
    turn: 0,
    turns: 0,
    tcp: 0,
    udp: 0,
    urls: [],
  };

  for (const server of iceServers || []) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const rawUrl of urls) {
      if (typeof rawUrl !== 'string') continue;
      const info = parseIceUrl(rawUrl);
      if (!info) continue;
      summary[info.scheme] += 1;
      if (info.scheme.startsWith('turn')) {
        summary[info.transport] += 1;
      }
      summary.urls.push(`${info.scheme}:${info.host}${info.transport ? `/${info.transport}` : ''}`);
    }
  }

  return `stun=${summary.stun}, turn=${summary.turn}, turns=${summary.turns}, tcp=${summary.tcp}, udp=${summary.udp}, urls=${summary.urls.join(' | ') || '无'}`;
}

export function describeIceUrl(url) {
  const info = parseIceUrl(url);
  if (!info) return '未知 ICE URL';
  return `${info.scheme}:${info.host}${info.transport ? `/${info.transport}` : ''}`;
}

export function describeCandidate(candidate) {
  const candidateText = candidate?.candidate || String(candidate || '');
  const parts = candidateText.trim().split(/\s+/);
  const type = getCandidateField(parts, 'typ') || candidate?.type || candidate?.candidateType || 'unknown';
  const protocol = candidate?.protocol || parts[2] || 'unknown';
  const address = getCandidateAddress(candidate);
  const family = getCandidateAddressFamily(candidate);
  const port = candidate?.port || parts[5] || 'unknown';
  const tcpType = getCandidateField(parts, 'tcptype') || candidate?.tcpType || '';
  const relayProtocol = candidate?.relayProtocol || '';
  const sdpMid = candidate?.sdpMid || '';
  const sdpMLineIndex = Number.isFinite(candidate?.sdpMLineIndex) ? candidate.sdpMLineIndex : '';

  return [
    `type=${type}`,
    `family=${family}`,
    address ? `address=${address}` : '',
    `protocol=${String(protocol).toUpperCase()}`,
    relayProtocol ? `relay=${relayProtocol}` : '',
    tcpType ? `tcp=${tcpType}` : '',
    `port=${port}`,
    sdpMid ? `mid=${sdpMid}` : '',
    sdpMLineIndex !== '' ? `mLine=${sdpMLineIndex}` : '',
  ].filter(Boolean).join(', ');
}

export function describeCandidatePair(localCandidate, remoteCandidate) {
  return `local(${describeCandidateReport(localCandidate)}) <-> remote(${describeCandidateReport(remoteCandidate)})`;
}

function describeCandidateReport(report) {
  if (!report) return '无';
  const address = report.address || report.ip || '';
  return [
    `type=${report.candidateType || report.type || 'unknown'}`,
    `family=${getAddressFamily(address)}`,
    address ? `address=${address}` : '',
    `protocol=${String(report.protocol || 'unknown').toUpperCase()}`,
    report.relayProtocol ? `relay=${report.relayProtocol}` : '',
    report.tcpType ? `tcp=${report.tcpType}` : '',
    report.port ? `port=${report.port}` : '',
    report.url ? `url=${describeIceUrl(report.url)}` : '',
  ].filter(Boolean).join(', ');
}

export function getCandidateAddress(candidate) {
  if (candidate?.address) return candidate.address;
  if (candidate?.ip) return candidate.ip;

  const candidateText = candidate?.candidate || String(candidate || '');
  const parts = candidateText.trim().split(/\s+/);
  return parts[4] || '';
}

export function getCandidateAddressFamily(candidate) {
  return getAddressFamily(getCandidateAddress(candidate));
}

export function isIPv6Candidate(candidate) {
  return getCandidateAddressFamily(candidate) === 'IPv6';
}

export function isIPv4Candidate(candidate) {
  return getCandidateAddressFamily(candidate) === 'IPv4';
}

function parseIceUrl(rawUrl) {
  const match = String(rawUrl).match(/^(stun|stuns|turn|turns):([^?]+)(?:\?transport=([a-z0-9-]+))?/i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const host = match[2].replace(/^\/\//, '');
  const transport = scheme.startsWith('turn') ? (match[3]?.toLowerCase() || (scheme === 'turns' ? 'tcp' : 'udp')) : '';
  return { scheme, host, transport };
}

function getCandidateField(parts, fieldName) {
  const index = parts.indexOf(fieldName);
  return index >= 0 ? parts[index + 1] : '';
}

function getAddressFamily(address) {
  if (!address) return 'unknown';
  if (/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(address)) return 'IPv4';
  if (address.includes(':')) return 'IPv6';
  if (address.endsWith('.local')) return 'mDNS';
  return 'unknown';
}
