import { View } from 'react-native';
import { useTheme } from '@/theme';

/** Entry: the auth guard in _layout redirects from here once the session has booted. */
export default function Index() {
  const t = useTheme();
  return <View style={{ flex: 1, backgroundColor: t.colors.background }} />;
}
