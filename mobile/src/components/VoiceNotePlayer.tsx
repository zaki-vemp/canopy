import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { buildAttachmentUrl } from '../api/client';
import type { AttachmentItem } from '../types/canopy';
import { PALETTE, TOUCH_MIN } from '../theme/palette';

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

const WAVE_HEIGHTS = [10, 18, 14, 24, 20, 12, 22, 16, 26, 14, 19, 12, 20, 15];

export function VoiceNotePlayer({ attachment }: { attachment: AttachmentItem }) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(attachment.durationMs || 4000);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
      }
    };
  }, []);

  const handleTogglePlay = async () => {
    setErrorMsg(null);
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      if (soundRef.current) {
        const status = await soundRef.current.getStatusAsync();
        if (status.isLoaded) {
          if (status.isPlaying) {
            await soundRef.current.pauseAsync();
            setIsPlaying(false);
          } else {
            if (
              status.durationMillis &&
              status.positionMillis >= status.durationMillis - 150
            ) {
              await soundRef.current.setPositionAsync(0);
            }
            await soundRef.current.playAsync();
            setIsPlaying(true);
          }
          return;
        }
      }

      const uri = buildAttachmentUrl(attachment.url);
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
        (status) => {
          if (!status.isLoaded) return;
          setIsPlaying(status.isPlaying);
          setPositionMs(status.positionMillis || 0);
          if (status.durationMillis && status.durationMillis > 0) {
            setDurationMs(status.durationMillis);
          }
          if (status.didJustFinish) {
            setIsPlaying(false);
            setPositionMs(0);
          }
        }
      );
      soundRef.current = sound;
      setIsPlaying(true);
    } catch {
      setErrorMsg('Audio preview unavailable on this device');
      setIsPlaying(false);
    }
  };

  const progressRatio =
    durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const activeBars = Math.round(progressRatio * WAVE_HEIGHTS.length);

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause voice note' : 'Play voice note'}
        onPress={handleTogglePlay}
        style={({ pressed }) => [
          styles.playButton,
          pressed && styles.playButtonPressed,
        ]}
      >
        <Ionicons
          name={isPlaying ? 'pause' : 'play'}
          size={20}
          color={PALETTE.charcoal}
        />
      </Pressable>

      <View style={styles.waveColumn}>
        <View style={styles.waveRow}>
          {WAVE_HEIGHTS.map((h, idx) => {
            const filled = isPlaying ? idx <= activeBars : idx === 0;
            return (
              <View
                key={idx}
                style={[
                  styles.waveBar,
                  {
                    height: h,
                    backgroundColor: filled ? PALETTE.forest : PALETTE.borderStrong,
                  },
                ]}
              />
            );
          })}
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>
            Voice Note · {formatMs(isPlaying ? positionMs : durationMs)}
          </Text>
          <Text style={styles.metaSize}>
            {Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB
          </Text>
        </View>
        {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: PALETTE.surface,
    borderWidth: 1,
    borderColor: PALETTE.border,
    borderRadius: 12,
    padding: 10,
    marginTop: 4,
  },
  playButton: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: PALETTE.mint,
    borderWidth: 1,
    borderColor: PALETTE.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playButtonPressed: {
    opacity: 0.8,
  },
  waveColumn: {
    flex: 1,
    gap: 4,
  },
  waveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
  },
  waveBar: {
    width: 4,
    borderRadius: 2,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaText: {
    fontSize: 12,
    fontWeight: '600',
    color: PALETTE.ink,
  },
  metaSize: {
    fontSize: 11,
    color: PALETTE.muted,
  },
  errorText: {
    fontSize: 11,
    color: PALETTE.danger,
  },
});
