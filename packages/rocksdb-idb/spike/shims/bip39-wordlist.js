// bip39-mnemonic's wordlist module, English only (Huwa phrases are English): the full module ships
// 12 languages plus a 650 KB lookup table, about 1 MB of the browser bundle.
const english = require('bip39-english-wordlist')

const set = new Set(english)

function loadWordlist(language) {
  if (language === 'english') return english
  throw new Error('Unknown language: ' + language)
}

function detectLanguage(words) {
  for (const w of words) if (!set.has(w)) return null
  return 'english'
}

module.exports = { loadWordlist, detectLanguage }
