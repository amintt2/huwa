// Deep link `huwa://paperback?repo=<repository URL>` (also accepts `url=`, as in Paperback's
// `paperback://addRepo?url=…`): forwards to the extensions screen, which adds the repository.
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function PaperbackLink() {
  const { repo, url } = useLocalSearchParams<{ repo?: string; url?: string }>();
  const target = repo ?? url;
  return <Redirect href={target ? { pathname: '/manga-sources', params: { repo: target } } : '/manga-sources'} />;
}
