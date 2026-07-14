import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { CryptidThemes, Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  CRYPTID_PRESETS,
  createCryptidProfile,
  DEFAULT_SIGNAL_COLOR,
  defaultCryptidProfileDraft,
  findCryptidPreset,
  handleInputValue,
  MAX_SIGIL_COLUMNS,
  MAX_SIGIL_LINES,
  normalizeAsciiArt,
  profileToDraft,
  sigilMeasurements,
  validateCryptidProfileFields,
  type CryptidPresetId,
  type CryptidProfile,
  type CryptidProfileDraft,
} from '../core/profile';
import type { GeneratedCryptid } from '../core/cryptid-generator';
import { CryptidAvatar } from './cryptid-avatar';
import { CryptidGeneratorDialog } from './cryptid-generator-dialog';
import { SignalColorPicker } from './signal-color-picker';

const AUTOSAVE_DELAY_MS = 450;
const PROFILE_MAX_WIDTH = 640;
const DEFAULT_CUSTOM_NAME = 'Custom Cryptid';

type ActiveEditor = 'username' | 'icon' | 'signal' | null;
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface QueuedProfile {
  key: string;
  profile: CryptidProfile;
}

interface CryptidProfileEditorProps {
  mode: 'onboarding' | 'edit';
  initialProfile?: CryptidProfile | null;
  notice?: string | null;
  onSave(profile: CryptidProfile): Promise<void>;
  onDone?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function profileKey(profile: CryptidProfile): string {
  return JSON.stringify(profile);
}

export function CryptidProfileEditor({
  mode,
  initialProfile,
  notice,
  onSave,
  onDone,
}: CryptidProfileEditorProps) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();
  const [initialDraft] = useState<CryptidProfileDraft>(() =>
    initialProfile ? profileToDraft(initialProfile) : defaultCryptidProfileDraft()
  );
  const initialPreset = findCryptidPreset(initialDraft.presetId);
  const initialColor = initialDraft.color || DEFAULT_SIGNAL_COLOR;

  const [handle, setHandle] = useState(handleInputValue(initialDraft.handle));
  const [selectedPresetId, setSelectedPresetId] = useState<CryptidPresetId | null>(
    initialPreset?.id ?? null
  );
  const [customName, setCustomName] = useState(initialPreset ? '' : initialDraft.cryptidName);
  const [customArt, setCustomArt] = useState(initialPreset ? '' : initialDraft.sigil);
  const [color, setColor] = useState(initialColor);
  const [activeEditor, setActiveEditor] = useState<ActiveEditor>(
    mode === 'onboarding' ? 'username' : null
  );
  const [handleTouched, setHandleTouched] = useState(false);
  const [customNameTouched, setCustomNameTouched] = useState(false);
  const [customArtTouched, setCustomArtTouched] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(initialProfile ? 'saved' : 'idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);

  const selectedPreset = findCryptidPreset(selectedPresetId);
  const cryptidName = selectedPreset?.name ?? customName;
  const sigil = selectedPreset?.art ?? customArt;
  const draft = useMemo<CryptidProfileDraft>(
    () => ({ handle, cryptidName, sigil, color, presetId: selectedPresetId }),
    [color, cryptidName, handle, selectedPresetId, sigil]
  );
  const fieldIssues = useMemo(() => validateCryptidProfileFields(draft), [draft]);
  const hasIssues = Object.values(fieldIssues).some((issues) => issues.length > 0);
  const validProfile = useMemo(
    () => (hasIssues ? null : createCryptidProfile(draft)),
    [draft, hasIssues]
  );
  const measurements = sigilMeasurements(sigil);
  const colorOptions = SIGNAL_COLOR_OPTIONS.some(
    (option) => option.value.toLowerCase() === initialColor.toLowerCase()
  )
    ? SIGNAL_COLOR_OPTIONS
    : [{ name: 'Current', value: initialColor }, ...SIGNAL_COLOR_OPTIONS];
  const bareHandle = handle.trim().replace(/^@+/, '');
  const iconName = cryptidName.trim() || 'Custom icon';
  const colorName =
    colorOptions.find((option) => option.value.toLowerCase() === color.toLowerCase())?.name ??
    'Custom';

  const mountedRef = useRef(true);
  const onSaveRef = useRef(onSave);
  const latestValidProfileRef = useRef(validProfile);
  const lastSavedKeyRef = useRef(initialProfile ? profileKey(initialProfile) : null);
  const desiredSaveRef = useRef<QueuedProfile | null>(null);
  const activeSaveRef = useRef<Promise<void> | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    latestValidProfileRef.current = validProfile;
  }, [validProfile]);

  const drainSaveQueue = useCallback((): Promise<void> => {
    if (activeSaveRef.current) return activeSaveRef.current;

    const run = (async () => {
      while (true) {
        const next = desiredSaveRef.current;
        if (!next || next.key === lastSavedKeyRef.current) break;

        if (mountedRef.current) {
          setSaveStatus('saving');
          setSaveError(null);
        }

        try {
          await onSaveRef.current(next.profile);
        } catch (error: unknown) {
          if (mountedRef.current) {
            setSaveError(errorMessage(error));
            setSaveStatus('error');
          }
          throw error;
        }

        lastSavedKeyRef.current = next.key;
      }

      if (mountedRef.current) {
        setSaveError(null);
        setSaveStatus('saved');
      }
    })();

    activeSaveRef.current = run;
    void run
      .finally(() => {
        if (activeSaveRef.current === run) activeSaveRef.current = null;
      })
      .catch(() => undefined);
    return run;
  }, []);

  const requestProfileSave = useCallback(
    (profile: CryptidProfile): Promise<void> => {
      const queued = { key: profileKey(profile), profile };
      desiredSaveRef.current = queued;
      if (queued.key === lastSavedKeyRef.current && !activeSaveRef.current) {
        if (mountedRef.current) {
          setSaveError(null);
          setSaveStatus('saved');
        }
        return Promise.resolve();
      }
      return drainSaveQueue();
    },
    [drainSaveQueue]
  );

  useEffect(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);

    if (!validProfile) {
      desiredSaveRef.current = null;
      return;
    }

    const key = profileKey(validProfile);
    desiredSaveRef.current = { key, profile: validProfile };
    if (key === lastSavedKeyRef.current && !activeSaveRef.current) {
      return;
    }

    autosaveTimerRef.current = setTimeout(() => {
      void requestProfileSave(validProfile).catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
  }, [requestProfileSave, validProfile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
      const profile = latestValidProfileRef.current;
      if (profile) void requestProfileSave(profile).catch(() => undefined);
    };
  }, [requestProfileSave]);

  const handleErrors = handleTouched ? fieldIssues.handle : [];
  const customNameErrors = customNameTouched ? fieldIssues.cryptidName : [];
  const customArtErrors = customArtTouched ? fieldIssues.sigil : [];
  const globalError = saveError ?? notice;
  const statusLabel =
    !hasIssues && saveStatus === 'saving'
      ? 'Saving...'
      : !hasIssues && saveStatus === 'saved'
        ? 'Saved'
        : !hasIssues && saveStatus === 'error'
          ? 'Not saved'
          : null;

  const finish = async (): Promise<void> => {
    if (!onDone || finishing) return;
    if (!validProfile) {
      if (mode === 'edit') onDone();
      return;
    }

    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    setFinishing(true);
    try {
      await requestProfileSave(validProfile);
      onDone();
    } catch {
      // The save error is surfaced next to the autosave status.
    } finally {
      if (mountedRef.current) setFinishing(false);
    }
  };

  const choosePreset = (presetId: CryptidPresetId | null): void => {
    setSaveError(null);
    setSaveStatus('idle');
    setSelectedPresetId(presetId);
    if (presetId === null) {
      setCustomName((current) => current.trim() || DEFAULT_CUSTOM_NAME);
      setCustomNameTouched(false);
      setCustomArtTouched(false);
    }
  };

  const useGeneratedCryptid = (generated: GeneratedCryptid): void => {
    setSaveError(null);
    setSaveStatus('idle');
    setSelectedPresetId(null);
    setCustomName(generated.name);
    setCustomArt(generated.sigil);
    setCustomNameTouched(false);
    setCustomArtTouched(false);
    setActiveEditor('icon');
    setGeneratorOpen(false);
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
            <View style={styles.headerCopy}>
              <ThemedText style={styles.title}>
                {mode === 'onboarding' ? 'Set up your profile' : 'Profile'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.intro}>
                {mode === 'onboarding'
                  ? 'Choose how you appear to friends. You can change this later.'
                  : 'This is how you appear to friends.'}
              </ThemedText>
            </View>
            {mode === 'edit' && onDone ? (
              <Pressable
                accessibilityRole="button"
                disabled={finishing}
                onPress={() => void finish()}
                style={({ pressed }) => [
                  styles.doneButton,
                  {
                    backgroundColor: theme.backgroundElement,
                    borderColor: theme.backgroundSelected,
                    opacity: finishing ? 0.45 : pressed ? 0.65 : 1,
                  },
                ]}
              >
                <ThemedText style={styles.doneButtonText}>
                  {finishing ? 'Saving...' : 'Done'}
                </ThemedText>
              </Pressable>
            ) : null}
          </View>

          {statusLabel ? (
            <ThemedText
              accessibilityLiveRegion="polite"
              type="small"
              themeColor="textSecondary"
              style={styles.saveStatus}
            >
              {statusLabel}
            </ThemedText>
          ) : null}

          {globalError ? (
            <View
              accessibilityLiveRegion="polite"
              style={[
                styles.notice,
                { backgroundColor: theme.backgroundElement, borderColor: chrome.amber },
              ]}
            >
              <ThemedText type="smallBold">Could not save profile changes</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {globalError}
              </ThemedText>
            </View>
          ) : null}

          <View
            style={[
              styles.overview,
              { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected },
            ]}
          >
            <View style={styles.preview}>
              <CryptidAvatar
                art={sigil || ' + '}
                name={iconName}
                color={color}
                size="large"
                style={styles.previewAvatar}
              />
              <ThemedText
                adjustsFontSizeToFit
                minimumFontScale={0.74}
                numberOfLines={1}
                style={[styles.handlePreview, { color: bareHandle ? color : theme.textSecondary }]}
              >
                {bareHandle ? `@${bareHandle}` : 'Not set'}
              </ThemedText>
            </View>

            <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

            <SettingRow
              active={activeEditor === 'username'}
              label="Username"
              value={bareHandle ? `@${bareHandle}` : 'Not set'}
              onPress={() =>
                setActiveEditor((current) => (current === 'username' ? null : 'username'))
              }
            />

            {activeEditor === 'username' ? (
              <View style={[styles.inlineEditor, { backgroundColor: theme.background }]}>
                <ThemedText style={styles.fieldLabel}>Username</ThemedText>
                <View
                  style={[
                    styles.handleInputShell,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor:
                        handleErrors.length > 0 ? chrome.amber : theme.backgroundSelected,
                    },
                  ]}
                >
                  <ThemedText style={[styles.handlePrefix, { color }]}>@</ThemedText>
                  <TextInput
                    accessibilityLabel="Username"
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={20}
                    onBlur={() => setHandleTouched(true)}
                    onChangeText={(value) => {
                      setSaveError(null);
                      setSaveStatus('idle');
                      setHandleTouched(true);
                      setHandle(value.replace(/^@+/, '').toLowerCase());
                    }}
                    placeholder="username"
                    placeholderTextColor={theme.textSecondary}
                    selectionColor={color}
                    spellCheck={false}
                    style={[styles.handleInput, { color: theme.text }]}
                    value={handle}
                  />
                </View>
                <FieldNote
                  errorColor={chrome.amberDark}
                  issues={handleErrors}
                  hint="Use 2-20 lowercase letters, numbers, underscores, or dashes."
                />
              </View>
            ) : null}

            <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

            <SettingRow
              active={activeEditor === 'icon'}
              label="Profile icon"
              value={iconName}
              onPress={() => setActiveEditor((current) => (current === 'icon' ? null : 'icon'))}
            />

            {activeEditor === 'icon' ? (
              <View style={[styles.inlineEditor, { backgroundColor: theme.background }]}>
                <ThemedText style={styles.fieldLabel}>Choose an icon</ThemedText>
                <View accessibilityLabel="Profile icon choices" style={styles.presetGrid}>
                  {CRYPTID_PRESETS.map((preset) => {
                    const selected = selectedPresetId === preset.id;
                    return (
                      <Pressable
                        accessibilityLabel={preset.name}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                        key={preset.id}
                        onPress={() => choosePreset(preset.id)}
                        style={({ pressed }) => [
                          styles.presetButton,
                          {
                            backgroundColor: selected ? `${color}14` : theme.backgroundElement,
                            borderColor: selected ? color : theme.backgroundSelected,
                            opacity: pressed ? 0.62 : 1,
                          },
                        ]}
                      >
                        <CryptidAvatar art={preset.art} name={preset.name} color={color} />
                      </Pressable>
                    );
                  })}
                  <Pressable
                    accessibilityLabel="Generate a profile icon"
                    accessibilityRole="button"
                    onPress={() => setGeneratorOpen(true)}
                    style={({ pressed }) => [
                      styles.presetButton,
                      styles.customButton,
                      {
                        backgroundColor: theme.backgroundElement,
                        borderColor: theme.backgroundSelected,
                        opacity: pressed ? 0.62 : 1,
                      },
                    ]}
                  >
                    <ThemedText style={[styles.generatorGlyph, { color }]}>{'{*}'}</ThemedText>
                    <ThemedText type="small" style={styles.customLabel}>
                      Generate
                    </ThemedText>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Custom profile icon"
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selectedPresetId === null }}
                    onPress={() => choosePreset(null)}
                    style={({ pressed }) => [
                      styles.presetButton,
                      styles.customButton,
                      {
                        backgroundColor:
                          selectedPresetId === null ? `${color}14` : theme.backgroundElement,
                        borderColor: selectedPresetId === null ? color : theme.backgroundSelected,
                        opacity: pressed ? 0.62 : 1,
                      },
                    ]}
                  >
                    <ThemedText style={[styles.customGlyph, { color }]}>+</ThemedText>
                    <ThemedText type="small" style={styles.customLabel}>
                      Custom
                    </ThemedText>
                  </Pressable>
                </View>

                {selectedPresetId === null ? (
                  <View style={styles.customFields}>
                    <ThemedText style={styles.fieldLabel}>Icon name</ThemedText>
                    <TextInput
                      accessibilityLabel="Custom profile icon name"
                      autoCapitalize="words"
                      maxLength={24}
                      onBlur={() => setCustomNameTouched(true)}
                      onChangeText={(value) => {
                        setSaveError(null);
                        setSaveStatus('idle');
                        setCustomNameTouched(true);
                        setCustomName(value);
                      }}
                      placeholder="Icon name"
                      placeholderTextColor={theme.textSecondary}
                      selectionColor={color}
                      style={[
                        styles.textInput,
                        {
                          backgroundColor: theme.backgroundElement,
                          borderColor:
                            customNameErrors.length > 0 ? chrome.amber : theme.backgroundSelected,
                          color: theme.text,
                        },
                      ]}
                      value={customName}
                    />
                    <FieldNote
                      errorColor={chrome.amberDark}
                      issues={customNameErrors}
                      hint="Use 1-24 characters."
                    />

                    <View style={styles.asciiLabelRow}>
                      <ThemedText style={styles.fieldLabel}>ASCII art</ThemedText>
                      <ThemedText type="code" themeColor="textSecondary">
                        {measurements.lines}/{MAX_SIGIL_LINES} lines · {measurements.columns}/
                        {MAX_SIGIL_COLUMNS} columns
                      </ThemedText>
                    </View>
                    <TextInput
                      accessibilityLabel="Custom ASCII profile icon"
                      allowFontScaling={false}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                      onBlur={() => setCustomArtTouched(true)}
                      onChangeText={(value) => {
                        setSaveError(null);
                        setSaveStatus('idle');
                        setCustomArtTouched(true);
                        setCustomArt(normalizeAsciiArt(value));
                      }}
                      placeholder={'Enter ASCII art.\nSpaces and line breaks are preserved.'}
                      placeholderTextColor={theme.textSecondary}
                      selectionColor={color}
                      spellCheck={false}
                      style={[
                        styles.asciiInput,
                        {
                          backgroundColor: theme.backgroundElement,
                          borderColor:
                            customArtErrors.length > 0 ? chrome.amber : theme.backgroundSelected,
                          color,
                        },
                      ]}
                      textAlignVertical="top"
                      value={customArt}
                    />
                    <FieldNote
                      errorColor={chrome.amberDark}
                      issues={customArtErrors}
                      hint="ASCII characters only. Spacing and line breaks are preserved."
                    />
                  </View>
                ) : null}
              </View>
            ) : null}

            <View style={[styles.divider, { backgroundColor: theme.backgroundSelected }]} />

            <SettingRow
              active={activeEditor === 'signal'}
              label="Signal color"
              value={colorName}
              onPress={() => setActiveEditor((current) => (current === 'signal' ? null : 'signal'))}
            />

            {activeEditor === 'signal' ? (
              <View style={[styles.inlineEditor, { backgroundColor: theme.background }]}>
                <ThemedText style={styles.fieldLabel}>Choose a signal color</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  This marks your profile icon, map pin, and shared trail on friends&apos; maps.
                </ThemedText>
                <SignalColorPicker
                  color={color}
                  onChange={(value) => {
                    setSaveError(null);
                    setSaveStatus('idle');
                    setColor(value);
                  }}
                />
                <ThemedText style={styles.fieldLabel}>Quick colors</ThemedText>
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
                        onPress={() => {
                          setSaveError(null);
                          setSaveStatus('idle');
                          setColor(option.value);
                        }}
                        style={({ pressed }) => [
                          styles.colorOption,
                          {
                            backgroundColor: selected
                              ? `${option.value}14`
                              : theme.backgroundElement,
                            borderColor: selected ? option.value : theme.backgroundSelected,
                            opacity: pressed ? 0.58 : 1,
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
                        <ThemedText type="small" style={styles.colorName}>
                          {option.name}
                        </ThemedText>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
          </View>

          {mode === 'onboarding' && onDone ? (
            <Pressable
              accessibilityRole="button"
              disabled={hasIssues || finishing}
              onPress={() => void finish()}
              style={({ pressed }) => [
                styles.continueButton,
                {
                  backgroundColor: color,
                  opacity: hasIssues || finishing ? 0.38 : pressed ? 0.72 : 1,
                },
              ]}
            >
              <ThemedText style={[styles.continueButtonText, { color: signalColorInk(color) }]}>
                {finishing ? 'Saving...' : 'Continue'}
              </ThemedText>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
      <CryptidGeneratorDialog
        color={color}
        onClose={() => setGeneratorOpen(false)}
        onUse={useGeneratedCryptid}
        visible={generatorOpen}
      />
    </KeyboardAvoidingView>
  );
}

function SettingRow({
  active,
  label,
  value,
  onPress,
}: {
  active: boolean;
  label: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.settingRow, { opacity: pressed ? 0.58 : 1 }]}
    >
      <View style={styles.settingCopy}>
        <ThemedText style={styles.settingLabel}>{label}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {value}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.editLabel}>
        {active ? 'Close' : 'Edit'}
      </ThemedText>
    </Pressable>
  );
}

function FieldNote({
  issues,
  hint,
  errorColor,
}: {
  issues: readonly string[];
  hint: string;
  errorColor: string;
}) {
  const hasError = issues.length > 0;
  return (
    <ThemedText
      accessibilityLiveRegion={hasError ? 'polite' : 'none'}
      type="small"
      themeColor={hasError ? undefined : 'textSecondary'}
      style={hasError ? { color: errorColor } : undefined}
    >
      {hasError ? issues.join(' ') : hint}
    </ThemedText>
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
    maxWidth: PROFILE_MAX_WIDTH,
    width: '100%',
  },
  headerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  title: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.4,
    lineHeight: 40,
  },
  intro: {
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 480,
  },
  doneButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 42,
    minWidth: 68,
    paddingHorizontal: Spacing.three,
  },
  doneButtonText: {
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
  },
  saveStatus: {
    alignSelf: 'flex-end',
    marginTop: -Spacing.two,
  },
  notice: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  overview: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  preview: {
    alignItems: 'center',
    gap: Spacing.three,
    minHeight: 224,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.five,
  },
  previewAvatar: {
    minHeight: 126,
  },
  handlePreview: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 32,
    fontWeight: '700',
    includeFontPadding: true,
    letterSpacing: 0.2,
    lineHeight: 42,
    maxWidth: '100%',
    paddingBottom: 2,
    textAlign: 'center',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  settingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 72,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  settingCopy: {
    flex: 1,
    gap: 3,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  editLabel: {
    fontWeight: '700',
  },
  inlineEditor: {
    gap: Spacing.two,
    padding: Spacing.three,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },
  handleInputShell: {
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 54,
    paddingHorizontal: Spacing.three,
  },
  handlePrefix: {
    fontFamily: Fonts.mono,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  handleInput: {
    flex: 1,
    fontFamily: Fonts.mono,
    fontSize: 17,
    lineHeight: 24,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.two,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  presetButton: {
    borderRadius: 12,
    borderWidth: 1,
    flexBasis: '30%',
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 104,
    minWidth: 96,
    padding: Spacing.two,
  },
  customButton: {
    alignItems: 'center',
    gap: Spacing.one,
  },
  customGlyph: {
    fontSize: 30,
    fontWeight: '400',
    lineHeight: 34,
  },
  generatorGlyph: {
    fontFamily: Fonts.mono,
    fontSize: 24,
    fontWeight: '600',
    lineHeight: 34,
  },
  customLabel: {
    fontWeight: '700',
  },
  customFields: {
    gap: Spacing.two,
    paddingTop: Spacing.two,
  },
  colorOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  colorOption: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    flexBasis: '28%',
    flexGrow: 1,
    gap: Spacing.one,
    minHeight: 74,
    minWidth: 84,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
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
    fontWeight: '700',
  },
  textInput: {
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 52,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  asciiLabelRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    justifyContent: 'space-between',
    marginTop: Spacing.two,
  },
  asciiInput: {
    borderRadius: 10,
    borderWidth: 1,
    fontFamily: Fonts.mono,
    fontSize: 14,
    lineHeight: 19,
    minHeight: 180,
    padding: Spacing.three,
  },
  continueButton: {
    alignItems: 'center',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: Spacing.three,
  },
  continueButtonText: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
});
