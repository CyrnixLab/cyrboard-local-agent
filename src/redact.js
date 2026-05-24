const TOKEN_PATTERNS = [
  /cyr_mcp_[a-f0-9]+/gi,
  /cyr_runner_[a-f0-9]+/gi,
  /(Authorization:\s*Bearer\s+)[^\s]+/gi,
  /(Bearer\s+)cyr_[^\s]+/gi,
];

export function redactSecrets(value) {
  let result = String(value || '');

  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, (match, prefix = '') => {
      if (typeof prefix === 'string' && prefix !== '') {
        return `${prefix}[redacted]`;
      }

      return '[redacted-token]';
    });
  }

  return result;
}
