import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from '../theme/ui';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { buildAttachmentUrl } from '../api/client';
import type { AttachmentItem } from '../types/canopy';
import { PIECES, TOUCH_MIN } from '../theme/palette';

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
          color={PIECES.sheet}
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
                    backgroundColor: filled ? PIECES.ink : 'rgba(17,17,17,0.35)',
                  },
                ]}
              />
            );
          })}
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>
            {formatMs(isPlaying ? positionMs : durationMs)}
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
    marginTop: 2,
  },
  playButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: PIECES.ink,
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
    fontSize: 13,
    fontFamily: 'DMMono_500Medium',
    color: PIECES.ink,
  },
  metaSize: {
    fontSize: 12,
    fontFamily: 'DMMono_500Medium',
    color: PIECES.ink2,
  },
  errorText: {
    fontSize: 13,
    color: PIECES.alarm,
  },
});
