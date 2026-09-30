// Reads an export file picked by the user (JSON), or JSON pasted as text.
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';

export async function pickJsonFile(): Promise<unknown | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'text/plain', '*/*'], copyToCacheDirectory: true });
  if (res.canceled || !res.assets?.[0]) return null;
  const text = await new File(res.assets[0].uri).text();
  return parseJsonText(text);
}

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text.trim().replace(/^﻿/, ''));
  } catch {
    throw new Error('Fichier illisible : ce n’est pas un JSON valide.');
  }
}
