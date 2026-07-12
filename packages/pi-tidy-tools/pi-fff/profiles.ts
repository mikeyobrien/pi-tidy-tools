export type PiFffPackageIdentity = "pi-fff" | "@ff-labs/pi-fff";
export type PiFffCapabilityProfile = "legacy" | "scoped";

export interface PiFffPackageProfile {
	readonly identity: PiFffPackageIdentity;
	readonly profile: PiFffCapabilityProfile;
	readonly minimum: string;
	readonly verified: string;
	readonly segments: readonly string[];
}

export const PI_FFF_PACKAGE_PROFILES: Readonly<Record<PiFffPackageIdentity, PiFffPackageProfile>> = Object.freeze({
	"pi-fff": Object.freeze({ identity: "pi-fff", profile: "legacy", minimum: "0.1.12", verified: "0.1.12", segments: Object.freeze(["pi-fff"]) }),
	"@ff-labs/pi-fff": Object.freeze({ identity: "@ff-labs/pi-fff", profile: "scoped", minimum: "0.6.0", verified: "0.9.6", segments: Object.freeze(["@ff-labs", "pi-fff"]) }),
});

export function matchPiFffSource(source: string | undefined): { packageProfile: PiFffPackageProfile; version?: string } | undefined {
	if (!source?.startsWith("npm:")) return undefined;
	for (const packageProfile of Object.values(PI_FFF_PACKAGE_PROFILES)) {
		const prefix = `npm:${packageProfile.identity}`;
		if (source === prefix) return { packageProfile };
		if (source.startsWith(`${prefix}@`) && source.length > prefix.length + 1) return { packageProfile, version: source.slice(prefix.length + 1) };
	}
	return undefined;
}
