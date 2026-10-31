import { disableNotifications } from "@/reminders/notifications";
import { cancelVoiceInput } from "./voiceInput";
import { resetSpeechPreferences } from "./speech";
import { resetVoiceConfiguration } from "./voiceConfig";
import { setReminderSoundEnabled } from "@/reminders/sound";

export const resetLocalPreferences = () => {
  disableNotifications();
  setReminderSoundEnabled(true);
  cancelVoiceInput();
  resetSpeechPreferences();
  resetVoiceConfiguration();
};
