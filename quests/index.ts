import definePlugin from "vencord-plugin-types";
import { findByProps } from "@webpack";
import { showToast } from "@toasts";

// Type definitions
interface Quest {
    id: string;
    config: {
        application: { id: string; name: string; };
        messages: { questName: string; };
        taskConfig: any;
        taskConfigV2: any;
        expiresAt: string;
        configVersion: number;
    };
    userStatus: {
        enrolledAt: string;
        completedAt?: string;
        progress?: { [key: string]: { value: number } };
        streamProgressSeconds?: number;
    };
}

interface Stores {
    ApplicationStreamingStore: any;
    RunningGameStore: any;
    QuestsStore: { quests: Map<string, Quest>; getQuest: (id: string) => Quest | undefined; };
    ChannelStore: any;
    GuildChannelStore: any;
    FluxDispatcher: any;
    api: any;
}

export default definePlugin({
    name: "Quests",
    description: "Automatically completes Discord quests when accepted.",
    authors: [{ name: "Your Name", id: "1234567890" }],

    stores: {} as Stores,
    cleanup: null as (() => void) | null,

    startQuestLogic() {
        const quest = [...this.stores.QuestsStore.quests.values()].find(q =>
            q.id !== "1248385850622869556" &&
            q.userStatus?.enrolledAt &&
            !q.userStatus?.completedAt &&
            new Date(q.config.expiresAt).getTime() > Date.now()
        );

        if (!quest) {
            showToast("No active quests to complete.", "info");
            return;
        }

        const taskConfig = quest.config.taskConfig ?? quest.config.taskConfigV2;
        const taskName = Object.keys(taskConfig.tasks)[0];

        if (!taskName) {
            showToast("Could not determine quest task.", "error");
            return;
        }

        const isApp = typeof (window as any).DiscordNative !== "undefined";

        switch (taskName) {
            case "WATCH_VIDEO":
            case "WATCH_VIDEO_ON_MOBILE":
                this.handleVideoQuest(quest, taskName);
                break;
            case "PLAY_ON_DESKTOP":
                if (!isApp) showToast("Play on Desktop quests require the desktop app.", "error");
                else this.handlePlayOnDesktopQuest(quest, taskName);
                break;
            case "STREAM_ON_DESKTOP":
                if (!isApp) showToast("Stream on Desktop quests require the desktop app.", "error");
                else this.handleStreamOnDesktopQuest(quest, taskName);
                break;
            case "PLAY_ACTIVITY":
                this.handlePlayActivityQuest(quest, taskName);
                break;
            default:
                showToast(`Unsupported quest type: ${taskName}`, "error");
        }
    },

    async handleVideoQuest(quest: Quest, taskName: string) {
        const { api } = this.stores;
        const secondsNeeded = quest.config.taskConfig.tasks[taskName].target;
        let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;
        const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
        let stop = false;
        this.cleanup = () => { stop = true; };

        showToast(`Spoofing video for ${quest.config.messages.questName}.`, "info");

        while (!stop) {
            const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + 10;
            if (maxAllowed - secondsDone >= 7) {
                const timestamp = secondsDone + 7;
                await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) } });
                secondsDone = Math.min(secondsNeeded, timestamp);
            }

            if (secondsDone >= secondsNeeded) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!stop) {
            await api.post({ url: `/quests/${quest.id}/video-progress`, body: { timestamp: secondsNeeded } });
            showToast(`Quest ${quest.config.messages.questName} completed!`, "success");
        }
    },

    async handlePlayOnDesktopQuest(quest: Quest, taskName: string) {
        const { RunningGameStore, FluxDispatcher, api } = this.stores;
        const secondsNeeded = quest.config.taskConfig.tasks[taskName].target;
        const res = await api.get({ url: `/applications/public?application_ids=${quest.config.application.id}` });
        const appData = res.body[0];
        const exeName = appData.executables.find((x: any) => x.os === "win32").name.replace(">", "");
        const fakeGame = {
            id: quest.config.application.id,
            pid: Math.floor(Math.random() * 30000) + 1000,
            name: appData.name,
            cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
            exeName,
            exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
            hidden: false,
            isLauncher: false,
            start: Date.now(),
        };

        const realGetRunningGames = RunningGameStore.getRunningGames;
        const realGetGameForPID = RunningGameStore.getGameForPID;
        RunningGameStore.getRunningGames = () => [fakeGame];
        RunningGameStore.getGameForPID = () => fakeGame;
        FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", added: [fakeGame], removed: [], games: [fakeGame] });

        const fn = (data: any) => {
            if (data.questId !== quest.id) return;
            const progress = data.userStatus.progress[taskName].value;
            showToast(`Quest progress: ${progress}/${secondsNeeded}`, "info");
            if (progress >= secondsNeeded) {
                showToast(`Quest ${quest.config.messages.questName} completed!`, "success");
                this.cleanup?.();
            }
        };
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);

        this.cleanup = () => {
            RunningGameStore.getRunningGames = realGetRunningGames;
            RunningGameStore.getGameForPID = realGetGameForPID;
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        };

        showToast(`Spoofed game to ${appData.name}.`, "info");
    },

    handleStreamOnDesktopQuest(quest: Quest, taskName: string) {
        const { ApplicationStreamingStore, FluxDispatcher } = this.stores;
        const secondsNeeded = quest.config.taskConfig.tasks[taskName].target;
        const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
        ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
            id: quest.config.application.id,
            pid: Math.floor(Math.random() * 30000) + 1000,
            sourceName: null,
        });

        const fn = (data: any) => {
            if (data.questId !== quest.id) return;
            const progress = data.userStatus.progress[taskName].value;
            showToast(`Quest progress: ${progress}/${secondsNeeded}`, "info");
            if (progress >= secondsNeeded) {
                showToast(`Quest ${quest.config.messages.questName} completed!`, "success");
                this.cleanup?.();
            }
        };
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);

        this.cleanup = () => {
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        };

        showToast(`Spoofed stream to ${quest.config.application.name}.`, "info");
    },

    async handlePlayActivityQuest(quest: Quest, taskName: string) {
        const { ChannelStore, GuildChannelStore, api } = this.stores;
        const secondsNeeded = quest.config.taskConfig.tasks[taskName].target;
        const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ?? Object.values(GuildChannelStore.getAllGuilds()).find((x: any) => x.VOCAL.length > 0)?.VOCAL[0].channel.id;
        if (!channelId) {
            showToast("Could not find a suitable channel for activity quest.", "error");
            return;
        }
        const streamKey = `call:${channelId}:1`;
        let stop = false;
        this.cleanup = () => { stop = true; };

        showToast(`Starting activity for ${quest.config.messages.questName}.`, "info");

        while (!stop) {
            const res = await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: false } });
            const progress = res.body.progress[taskName].value;
            showToast(`Quest progress: ${progress}/${secondsNeeded}`, "info");

            if (progress >= secondsNeeded) {
                await api.post({ url: `/quests/${quest.id}/heartbeat`, body: { stream_key: streamKey, terminal: true } });
                showToast(`Quest ${quest.config.messages.questName} completed!`, "success");
                break;
            }
            await new Promise(r => setTimeout(r, 20 * 1000));
        }
    },

    onLoad() {
        this.stores.ApplicationStreamingStore = findByProps("getStreamerActiveStreamMetadata");
        this.stores.RunningGameStore = findByProps("getRunningGames");
        this.stores.QuestsStore = findByProps("getQuest");
        this.stores.ChannelStore = findByProps("getAllThreadsForParent");
        this.stores.GuildChannelStore = findByProps("getSFWDefaultChannel");
        this.stores.FluxDispatcher = findByProps("dispatch", "subscribe");
        this.stores.api = findByProps("get", "post");

        if (Object.values(this.stores).some(s => !s)) {
            showToast("Failed to find all required modules for Quests plugin.", "error");
            return;
        }

        this.startQuestLogic();
    },

    onUnload() {
        this.cleanup?.();
    }
});