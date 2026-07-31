if (process.env.NODE_ENV === 'production') {
  throw new Error('The unsigned development server cannot run in production');
}
process.env.DEV_ALLOW_UNSIGNED = '1';
await import('./index.js');
