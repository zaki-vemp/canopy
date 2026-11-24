import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '../theme/ui';
import { PIECES, TOUCH_MIN } from '../theme/palette';

// A white sheet that rises over the grey table. Title on the left, a round
// close button on the right, content scrolls underneath.
export function Sheet({
  visible,
  title,
  lead,
  onClose,
  children,
  footer,
}: {
  visible: boolean;
  title: string;
  lead?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          accessibilityLabel={`Close ${title}`}
          style={styles.backdropHit}
          onPress={onClose}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheet}
        >
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>{title}</Text>
              {lead ? <Text style={styles.lead}>{lead}</Text> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={styles.close}
            >
              <Ionicons name="close" size={22} color={PIECES.ink} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? <View style={styles.footer}>{footer}</View> : null}
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17, 17, 17, 0.45)',
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  backdropHit: { ...StyleSheet.absoluteFillObject },
  sheet: {
    width: '100%',
    maxWidth: 640,
    backgroundColor: PIECES.sheet,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '92%',
    minHeight: '40%',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  headerText: { flex: 1, gap: 6 },
  title: { fontSize: 26, lineHeight: 30, color: PIECES.ink, fontWeight: '600' },
  lead: { fontSize: 15, lineHeight: 21, color: PIECES.muted },
  close: {
    width: TOUCH_MIN,
    height: TOUCH_MIN,
    borderRadius: TOUCH_MIN / 2,
    backgroundColor: PIECES.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: 20, paddingVertical: 12, gap: 14 },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
    backgroundColor: PIECES.sheet,
  },
});
