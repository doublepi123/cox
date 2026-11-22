export const JAVASCRIPT_TRIM_WHITESPACE =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const DEFERRED_COMMAND_MESSAGE_CONDITION = `role = 'user' AND trim(json_extract(payload_json, '$.text'), '${JAVASCRIPT_TRIM_WHITESPACE}') GLOB '/*'`;
