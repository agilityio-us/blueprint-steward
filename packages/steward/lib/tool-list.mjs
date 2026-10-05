// A tool list as claude reads one, space- or comma-separated; empty entries dropped.
// A separator inside parentheses belongs to the rule it is in, so a scoped rule such as
// "Bash(git log *)" stays one entry rather than three. An unclosed parenthesis runs to the end of the value.
export const toolList = ( value ) => {
  const tools = [];
  let current = '';
  let depth = 0;
  for ( const char of String( value ) ) {
    if ( char === '(' ) depth += 1;
    if ( char === ')' && depth > 0 ) depth -= 1;
    if ( depth === 0 && /[\s,]/.test( char ) ) {
      if ( current !== '' ) tools.push( current );
      current = '';
    } else {
      current += char;
    }
  }
  if ( current !== '' ) tools.push( current );
  return tools;
};
