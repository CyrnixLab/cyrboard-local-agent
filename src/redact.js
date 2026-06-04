const TOKEN_PATTERNS = [
  /cyr_mcp(?:_[a-z0-9]+)+/gi,
  /cyr_runner(?:_[a-z0-9]+)+/gi,
  /(Authorization:\s*Bearer\s+)[^\s]+/gi,
  /(Bearer\s+)cyr_[^\s]+/gi,
  /(\bCYRBOARD_[A-Z0-9_]*TOKEN[A-Z0-9_]*=)[^\s]+/gi,
  /("[^"]*token[^"]*"\s*:\s*")[^"]+(")/gi,
];

export function redactSecrets(value) {
  let result = String(value || '');

  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, (match, prefix = '', suffix = '') => {
      if (typeof prefix === 'string' && prefix !== '') {
        return `${prefix}[redacted]${typeof suffix === 'string' ? suffix : ''}`;
      }

      return '[redacted-token]';
    });
  }

  return result;
}
