import React from "react";
import { LunaSettings, LunaSwitchSetting } from "@luna/ui";
import { settings, persistFlag, unpersistFlag } from ".";

export const Settings = () => {
	const [optimize, setOptimize] = React.useState(settings.optimizeStartup);

	const onChange = React.useCallback(
		(_: React.ChangeEvent<HTMLInputElement>, checked?: boolean) => {
			const value = checked ?? false;
			setOptimize((settings.optimizeStartup = value));
			if (value) void persistFlag();
			else void unpersistFlag();
		},
		[],
	);

	return (
		<LunaSettings>
			<LunaSwitchSetting
				title="Optimize startup (avoid restarts)"
				desc="Adds the flag that disables Chromium's media session to TIDAL's autostart command, so shuffle and repeat work immediately with no relaunch. Modifies TIDAL's autostart entry (reversible by turning this off)."
				checked={optimize}
				onChange={onChange}
			/>
		</LunaSettings>
	);
};
