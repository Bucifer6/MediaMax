import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { VideoPlayerScreen } from '@/player/VideoPlayerScreen';

export default function LivePlayerRoute() {
  const { id, catchupStart, duration, category } = useLocalSearchParams<{ id: string; catchupStart?: string; duration?: string; category?: string }>();
  return (
    <VideoPlayerScreen
      key={`${id}-${catchupStart ?? 'live'}`}
      target={{ kind: 'live', channelId: id, catchupStart, durationMin: duration ? Number(duration) : undefined, categoryId: category }}
    />
  );
}
