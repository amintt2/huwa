// Web stand-in for the '@expo/vector-icons' index (aliased in metro.config.js for the web only).
// The index re-exports every icon family, and Metro then copies all 19 fonts into dist/. The app
// only draws Ionicons; other families are reached through their own entry point
// ('@expo/vector-icons/Ionicons'), which this alias does not touch.
export { default as Ionicons } from '@expo/vector-icons/Ionicons';
