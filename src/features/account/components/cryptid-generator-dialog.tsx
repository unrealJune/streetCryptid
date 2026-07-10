import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { signalColorInk } from '@/constants/signal-colors';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { generateCryptid, type GeneratedCryptid } from '../core/cryptid-generator';
import { CryptidAvatar } from './cryptid-avatar';

type GenerationStatus = 'idle' | 'generating' | 'ready' | 'error';

interface CryptidGeneratorDialogProps {
  visible: boolean;
  color: string;
  onClose(): void;
  onUse(generated: GeneratedCryptid): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The icon could not be generated. Try another description.';
}

export function CryptidGeneratorDialog({
  visible,
  color,
  onClose,
  onUse,
}: CryptidGeneratorDialogProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const reducedMotion = useReducedMotion();
  const seedRef = useRef(0);
  const [description, setDescription] = useState('');
  const [generated, setGenerated] = useState<GeneratedCryptid | null>(null);
  const [status, setStatus] = useState<GenerationStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const runGeneration = async (): Promise<void> => {
    if (status === 'generating') return;
    seedRef.current += 1;
    setStatus('generating');
    setError(null);

    try {
      const result = await generateCryptid(description, Date.now() + seedRef.current);
      setGenerated(result);
      setStatus('ready');
    } catch (generationError: unknown) {
      setError(errorMessage(generationError));
      setStatus('error');
    }
  };

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      statusBarTranslucent
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <View
          accessibilityViewIsModal
          style={[
            styles.dialog,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.backgroundSelected,
            },
          ]}
        >
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <ThemedText style={styles.title}>Generate an icon</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.intro}>
                Describe its shape, habitat, or mood. Nothing leaves your phone.
              </ThemedText>
            </View>
            <Pressable
              accessibilityLabel="Keep current profile icon"
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [styles.closeButton, { opacity: pressed ? 0.55 : 1 }]}
            >
              <ThemedText type="smallBold">Keep current</ThemedText>
            </Pressable>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.field}>
              <ThemedText style={styles.fieldLabel}>Description</ThemedText>
              <TextInput
                accessibilityLabel="Cryptid description"
                autoFocus
                editable={status !== 'generating'}
                maxLength={160}
                multiline
                onChangeText={(value) => {
                  setDescription(value);
                  if (status === 'error') {
                    setError(null);
                    setStatus(generated ? 'ready' : 'idle');
                  }
                }}
                placeholder="Antlered, rain-soaked, shy"
                placeholderTextColor={theme.textSecondary}
                selectionColor={color}
                style={[
                  styles.descriptionInput,
                  {
                    backgroundColor: theme.background,
                    borderColor: error ? chrome.amber : theme.backgroundSelected,
                    color: theme.text,
                  },
                ]}
                textAlignVertical="top"
                value={description}
              />
              <ThemedText type="small" themeColor="textSecondary">
                Leave this blank for a surprise.
              </ThemedText>
            </View>

            {status === 'generating' ? (
              <View
                accessibilityLiveRegion="polite"
                style={[styles.statusPanel, { backgroundColor: theme.background }]}
              >
                <View style={styles.statusRow}>
                  {reducedMotion ? null : <ActivityIndicator color={color} size="small" />}
                  <ThemedText style={styles.statusTitle}>Generating on this phone...</ThemedText>
                </View>
                <ThemedText type="small" themeColor="textSecondary">
                  The first icon can take up to a minute while the system model gets ready.
                </ThemedText>
              </View>
            ) : null}

            {error ? (
              <View
                accessibilityLiveRegion="polite"
                style={[
                  styles.errorPanel,
                  { backgroundColor: theme.background, borderColor: chrome.amber },
                ]}
              >
                <ThemedText type="smallBold">Could not generate an icon</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {error}
                </ThemedText>
              </View>
            ) : null}

            {generated ? (
              <View
                accessibilityLiveRegion="polite"
                style={[styles.preview, { backgroundColor: theme.background }]}
              >
                <CryptidAvatar
                  art={generated.sigil}
                  color={color}
                  name={generated.name}
                  size="large"
                  style={styles.previewAvatar}
                />
                <ThemedText type="small" themeColor="textSecondary" style={styles.sourceNote}>
                  {generated.source === 'system'
                    ? "Generated with this phone's on-device model."
                    : "Generated with streetCryptid's offline icon maker."}
                </ThemedText>
              </View>
            ) : null}

            <View style={styles.actions}>
              {generated ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={status === 'generating'}
                  onPress={() => onUse(generated)}
                  style={({ pressed }) => [
                    styles.actionButton,
                    {
                      backgroundColor: color,
                      opacity: status === 'generating' ? 0.38 : pressed ? 0.72 : 1,
                    },
                  ]}
                >
                  <ThemedText style={[styles.primaryActionText, { color: signalColorInk(color) }]}>
                    Use this icon
                  </ThemedText>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={status === 'generating'}
                onPress={() => void runGeneration()}
                style={({ pressed }) => [
                  styles.actionButton,
                  generated ? styles.secondaryButton : null,
                  {
                    backgroundColor: generated ? theme.backgroundElement : color,
                    borderColor: generated ? theme.backgroundSelected : color,
                    opacity: status === 'generating' ? 0.38 : pressed ? 0.72 : 1,
                  },
                ]}
              >
                <ThemedText
                  style={[
                    styles.actionText,
                    generated ? undefined : { color: signalColorInk(color) },
                  ]}
                >
                  {status === 'generating'
                    ? 'Generating...'
                    : generated
                      ? 'Generate another'
                      : 'Generate icon'}
                </ThemedText>
              </Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: '#00000066',
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.three,
  },
  dialog: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: '88%',
    maxWidth: 520,
    overflow: 'hidden',
    width: '100%',
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  headerCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
  },
  intro: {
    lineHeight: 20,
    maxWidth: 360,
  },
  closeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: Spacing.one,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  content: {
    gap: Spacing.three,
    padding: Spacing.three,
  },
  field: {
    gap: Spacing.two,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  descriptionInput: {
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 104,
    padding: Spacing.three,
  },
  statusPanel: {
    borderRadius: 12,
    gap: Spacing.two,
    padding: Spacing.three,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  statusTitle: {
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
  },
  errorPanel: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  preview: {
    alignItems: 'center',
    borderRadius: 12,
    gap: Spacing.two,
    minHeight: 190,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
  },
  previewAvatar: {
    minHeight: 132,
  },
  sourceNote: {
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  actionButton: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexBasis: 190,
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 52,
    paddingHorizontal: Spacing.three,
  },
  secondaryButton: {
    borderWidth: 1,
  },
  actionText: {
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
  },
  primaryActionText: {
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
  },
});
