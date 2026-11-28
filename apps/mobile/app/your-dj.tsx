/**
 * Your DJ (opened from its tile in Library): the one-tap personal set, its play rules and, with Advanced DJ on,
 * the DJ booth. It used to sit on Home; it lives with the music now.
 */
import { ScrollView } from 'react-native';
import { Screen, ScreenHeader } from '@/components/Screen';
import { YourDjCard } from '@/components/YourDjCard';
import { useTheme } from '@/theme';

export default function YourDjScreen() {
  const t = useTheme();
  return (
    <Screen>
      <ScreenHeader title="Your DJ" subtitle="A set picked from your music, mixed like a DJ would" />
      <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl }}>
        <YourDjCard />
      </ScrollView>
    </Screen>
  );
}
