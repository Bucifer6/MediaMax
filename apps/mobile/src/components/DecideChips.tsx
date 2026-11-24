/** Home entry points for Roulette ("Can't decide? Spin") and Movie Match. */
import { View } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '@/theme';
import { Chip } from './Chip';

export function DecideChips() {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingVertical: t.space.sm }}>
      <Chip label="Can't decide? Spin" icon="shuffle" onPress={() => router.push('/roulette' as never)} />
      <Chip label="Movie Match" icon="people-outline" onPress={() => router.push('/match' as never)} />
    </View>
  );
}
