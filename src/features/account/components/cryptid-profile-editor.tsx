import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { SIGNAL_COLOR_OPTIONS, signalColorInk } from '@/constants/signal-colors';
import { CryptidThemes, Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import {
  CRYPTID_PRESETS,
  createCryptidProfile,
  defaultCryptidProfileDraft,
  findCryptidPreset,
  handleInputValue,
  MAX_SIGIL_COLUMNS,
  MAX_SIGIL_LINES,
  normalizeAsciiArt,
  profileToDraft,
  sigilMeasurements,
  validateCryptidProfile,
  type CryptidPresetId,
  type CryptidProfile,
} from '../core/profile';
import { CryptidAvatar } from './cryptid-avatar';
import { useTheme } from '@/hooks/use-theme';

interface CryptidProfileEditorProps {
  mode: 'onboarding' | 'edit';
  initialProfile?: CryptidProfile | null;
  notice?: string | null;
  onSave(profile: CryptidProfile): Promise<void>;
  onCancel?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CryptidProfileEditor({
  mode,
  initialProfile,
  notice,
  onSave,
  onCancel,
}: CryptidProfileEditorProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();
  const initialDraft = initialProfile
    ? profileToDraft(initialProfile)
    : defaultCryptidProfileDraft();
  const initialPreset = findCryptidPreset(initialDraft.presetId);

  const [handle, setHandle] = useState(handleInputValue(initialDraft.handle));
  const [selectedPresetId, setSelectedPresetId] = useState<CryptidPresetId | null>(
    initialPreset?.id ?? null
  );
  const [customName, setCustomName] = useState(initialPreset ? '' : initialDraft.cryptidName);
  const [customArt, setCustomArt] = useState(initialPreset ? '' : initialDraft.sigil);
  const [color, setColor] = useState(initialDraft.color);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedPreset = findCryptidPreset(selectedPresetId);
  const cryptidName = selectedPreset?.name ?? customName;
  const sigil = selectedPreset?.art ?? customArt;
  const draft = { handle, cryptidName, sigil, color, presetId: selectedPresetId };
  const issues = validateCryptidProfile(draft);
  const measurements = sigilMeasurements(sigil);
  const displayHandle = handle.trim().replace(/^@+/, '') || 'unnamed';
  const colorOptions = SIGNAL_COLOR_OPTIONS.some(
    (option) => option.value.toLowerCase() === initialDraft.color.toLowerCase()
  )
    ? SIGNAL_COLOR_OPTIONS
    : [{ name: 'Current', value: initialDraft.color }, ...SIGNAL_COLOR_OPTIONS];

  const submit = async (): Promise<void> => {
    if (issues.length > 0 || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(createCryptidProfile(draft));
    } catch (error: unknown) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: theme.background }]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.four,
            paddingBottom: insets.bottom + Spacing.four,
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.shell}>
          <View style={styles.headerRow}>
            <ThemedText type="code" style={[styles.eyebrow, { color }]}>
              {mode === 'onboarding' ? 'IDENTITY / 01' : 'IDENTITY / EDIT'}
            </ThemedText>
            {onCancel ? (
              <Pressable
                accessibilityRole="button"
                onPress={onCancel}
                style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
              >
                <ThemedText type="code" themeColor="textSecondary" style={styles.cancel}>
                  CANCEL
                </ThemedText>
              </Pressable>
            ) : (
              <View style={styles.localOnly}>
                <View style={[styles.statusDot, { backgroundColor: color }]} />
                <ThemedText type="code" themeColor="textSecondary">
                  LOCAL FIRST
                </ThemedText>
              </View>
            )}
          </View>

          <ThemedText style={styles.title}>
            {mode === 'onboarding' ? 'CLAIM YOUR SIGNAL' : 'TUNE YOUR SIGNAL'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.intro}>
            Choose the handle and ASCII form friends will see after you pair.
          </ThemedText>

          {notice ? (
            <View
              style={[
                styles.notice,
                { borderColor: chrome.amber, backgroundColor: theme.backgroundElement },
              ]}
            >
              <ThemedText type="smallBold" style={{ color: chrome.amberDark }}>
                LOCAL PROFILE NEEDS ATTENTION
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {notice}
              </ThemedText>
            </View>
          ) : null}

          <View
            style={[
              styles.preview,
              { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected },
            ]}
          >
            <ThemedText type="code" themeColor="textSecondary" style={styles.previewLabel}>
              FRIEND PROFILE / LIVE PREVIEW
            </ThemedText>
            <CryptidAvatar
              art={sigil || ' '}
              name={cryptidName || 'Unknown form'}
              color={color}
              size="large"
              style={styles.previewAvatar}
            />
            <ThemedText style={[styles.handlePreview, { color }]}>@{displayHandle}</ThemedText>
          </View>

          <EditorSection
            index="01"
            title="CRYPTID NAME"
            detail="Your public handle. Lowercase, no spaces."
          />
          <View
            style={[
              styles.handleInputShell,
              { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected },
            ]}
          >
            <ThemedText style={[styles.handlePrefix, { color }]}>@</ThemedText>
            <TextInput
              accessibilityLabel="Cryptid name"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={20}
              onChangeText={(value) => setHandle(value.replace(/^@+/, '').toLowerCase())}
              placeholder="wanderer"
              placeholderTextColor={theme.textSecondary}
              selectionColor={color}
              spellCheck={false}
              style={[styles.handleInput, { color: theme.text }]}
              value={handle}
            />
          </View>

          <EditorSection
            index="02"
            title="CHOOSE A FORM"
            detail="Choose a field sigil or paste your own ASCII art."
          />
          <View style={styles.presetGrid}>
            {CRYPTID_PRESETS.map((preset) => {
              const selected = selectedPresetId === preset.id;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  key={preset.id}
                  onPress={() => setSelectedPresetId(preset.id)}
                  style={({ pressed }) => [
                    styles.presetCard,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: selected ? color : theme.backgroundSelected,
                      opacity: pressed ? 0.68 : 1,
                    },
                  ]}
                >
                  <CryptidAvatar art={preset.art} name={preset.name} color={color} />
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selectedPresetId === null }}
              onPress={() => setSelectedPresetId(null)}
              style={({ pressed }) => [
                styles.presetCard,
                styles.customCard,
                {
                  backgroundColor: theme.backgroundElement,
                  borderColor: selectedPresetId === null ? color : theme.backgroundSelected,
                  opacity: pressed ? 0.68 : 1,
                },
              ]}
            >
              <ThemedText style={[styles.customGlyph, { color }]}>+_</ThemedText>
              <ThemedText type="code" style={[styles.customLabel, { color }]}>
                CUSTOM FORM
              </ThemedText>
            </Pressable>
          </View>

          {selectedPresetId === null ? (
            <View style={styles.customFields}>
              <ThemedText type="code" themeColor="textSecondary" style={styles.fieldLabel}>
                FORM NAME
              </ThemedText>
              <TextInput
                accessibilityLabel="Custom cryptid form name"
                autoCapitalize="words"
                maxLength={24}
                onChangeText={setCustomName}
                placeholder="Tunnel Oracle"
                placeholderTextColor={theme.textSecondary}
                selectionColor={color}
                style={[
                  styles.textInput,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.backgroundSelected,
                    color: theme.text,
                  },
                ]}
                value={customName}
              />

              <View style={styles.asciiLabelRow}>
                <ThemedText type="code" themeColor="textSecondary" style={styles.fieldLabel}>
                  ASCII FORM
                </ThemedText>
                <ThemedText type="code" themeColor="textSecondary">
                  {measurements.lines}/{MAX_SIGIL_LINES} LINES · {measurements.columns}/
                  {MAX_SIGIL_COLUMNS} COL
                </ThemedText>
              </View>
              <TextInput
                accessibilityLabel="Custom ASCII cryptid"
                allowFontScaling={false}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                onChangeText={(value) => setCustomArt(normalizeAsciiArt(value))}
                placeholder={'Paste ASCII art here.\nSpaces and line breaks stay exact.'}
                placeholderTextColor={theme.textSecondary}
                selectionColor={color}
                spellCheck={false}
                style={[
                  styles.asciiInput,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.backgroundSelected,
                    color,
                  },
                ]}
                textAlignVertical="top"
                value={customArt}
              />
              <ThemedText type="small" themeColor="textSecondary">
                Spacing and line breaks are preserved.
              </ThemedText>
            </View>
          ) : null}

          <EditorSection
            index="03"
            title="CHOOSE A SIGNAL"
            detail="This color marks your ASCII form, map pin, and shared trail on friends' maps."
          />
          <View
            accessibilityLabel="Signal color"
            accessibilityRole="radiogroup"
            style={styles.colorOptions}
          >
            {colorOptions.map((option) => {
              const selected = option.value.toLowerCase() === color.toLowerCase();
              return (
                <Pressable
                  accessibilityLabel={`${option.name} signal color`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  key={option.value}
                  onPress={() => setColor(option.value)}
                  style={({ pressed }) => [styles.colorOption, { opacity: pressed ? 0.58 : 1 }]}
                >
                  <View
                    style={[
                      styles.colorRing,
                      {
                        borderColor: selected ? option.value : theme.backgroundSelected,
                      },
                    ]}
                  >
                    <View style={[styles.colorSwatch, { backgroundColor: option.value }]}>
                      {selected ? (
                        <View
                          style={[
                            styles.colorSelected,
                            { backgroundColor: signalColorInk(option.value) },
                          ]}
                        />
                      ) : null}
                    </View>
                  </View>
                  <ThemedText type="code" themeColor="textSecondary" style={styles.colorName}>
                    {option.name.toUpperCase()}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.footer}>
            {(saveError ?? issues[0]) ? (
              <ThemedText type="small" style={{ color: chrome.amberDark }}>
                {saveError ?? issues[0]}
              </ThemedText>
            ) : (
              <ThemedText type="small" themeColor="textSecondary">
                Ready.
              </ThemedText>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={issues.length > 0 || saving}
              onPress={() => void submit()}
              style={({ pressed }) => [
                styles.saveButton,
                {
                  backgroundColor: color,
                  opacity: issues.length > 0 || saving ? 0.38 : pressed ? 0.72 : 1,
                },
              ]}
            >
              <ThemedText style={[styles.saveButtonText, { color: signalColorInk(color) }]}>
                {saving
                  ? 'WRITING IDENTITY...'
                  : mode === 'onboarding'
                    ? 'ENTER THE MAP'
                    : 'SAVE PROFILE'}
              </ThemedText>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function EditorSection({ index, title, detail }: { index: string; title: string; detail: string }) {
  return (
    <View style={styles.sectionHeader}>
      <ThemedText type="code" themeColor="textSecondary" style={styles.sectionIndex}>
        {index}
      </ThemedText>
      <View style={styles.sectionCopy}>
        <ThemedText style={styles.sectionTitle}>{title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {detail}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.four,
  },
  shell: {
    alignSelf: 'center',
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    width: '100%',
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  eyebrow: {
    fontWeight: '700',
    letterSpacing: 2,
  },
  cancel: {
    letterSpacing: 1.5,
  },
  localOnly: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  statusDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  title: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: 3,
    lineHeight: 42,
  },
  intro: {
    maxWidth: 560,
  },
  notice: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  preview: {
    borderRadius: Spacing.three,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 250,
    overflow: 'hidden',
    padding: Spacing.four,
  },
  previewLabel: {
    letterSpacing: 1.5,
  },
  previewAvatar: {
    flex: 1,
    minHeight: 150,
  },
  handlePreview: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 31,
    fontWeight: '700',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  sectionHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    marginTop: Spacing.two,
  },
  sectionIndex: {
    letterSpacing: 1.5,
    paddingTop: 4,
  },
  sectionCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  sectionTitle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 2,
  },
  handleInputShell: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    minHeight: 58,
    paddingHorizontal: Spacing.three,
  },
  handlePrefix: {
    fontFamily: Fonts.mono,
    fontSize: 22,
    fontWeight: '700',
  },
  handleInput: {
    flex: 1,
    fontFamily: Fonts.mono,
    fontSize: 19,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.two,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  presetCard: {
    borderRadius: Spacing.two,
    borderWidth: 1,
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 122,
    minWidth: 138,
    overflow: 'hidden',
    padding: Spacing.three,
  },
  customCard: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  customGlyph: {
    fontFamily: Fonts.mono,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  customLabel: {
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  customFields: {
    gap: Spacing.two,
  },
  colorOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  colorOption: {
    alignItems: 'center',
    gap: Spacing.one,
    minHeight: 68,
    minWidth: 64,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.two,
  },
  colorRing: {
    alignItems: 'center',
    borderRadius: 24,
    borderWidth: 2,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  colorSwatch: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  colorSelected: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  colorName: {
    fontSize: 10,
    letterSpacing: 0.8,
  },
  fieldLabel: {
    letterSpacing: 1.25,
  },
  textInput: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: Fonts.mono,
    fontSize: 15,
    minHeight: 52,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  asciiLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  asciiInput: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: Fonts.mono,
    fontSize: 14,
    lineHeight: 18,
    minHeight: 190,
    padding: Spacing.three,
  },
  footer: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  saveButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    justifyContent: 'center',
    minHeight: 58,
    paddingHorizontal: Spacing.three,
  },
  saveButtonText: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 2,
  },
});
