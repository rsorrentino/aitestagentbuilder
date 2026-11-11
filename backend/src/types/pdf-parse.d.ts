// pdf-parse's package entry runs a debug self-test when imported from ESM,
// so the library file is imported directly.
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdfParse from 'pdf-parse';
  export default pdfParse;
}
