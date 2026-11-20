import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { VideoPlayerScreen } from '@/player/VideoPlayerScreen';

export default function PlayerRoute() {
  const { id, start } = useLocalSearchParams<{ id: string; start?: string }>();
  return <VideoPlayerScreen key={id} target={{ kind: 'vod', itemId: id, startMs: start ? Number(start) : undefined }} />;
}
