import * as React from 'react';
import { useApp } from './AppContext';
import { canGoBack } from './screenStack';

/** Shared header (REBUILD_PLAN §10): Back arrow when there is somewhere to go back to, title, location badge. */
export function Header({ title }: { title: string }) {
	const { stack, goBack, profile } = useApp();
	const back = canGoBack(stack);
	return (
		<gridLayout className="header" columns="auto, *, auto" rows="*">
			{back ? (
				<button col={0} className="header-back" text="←" accessibilityLabel="Back" onTap={goBack} />
			) : (
				<label col={0} width={8} />
			)}
			<label col={1} className="header-title" text={title} textWrap={false} />
			<label col={2} className={profile ? 'header-badge' : 'header-badge none'} text={profile ? profile.location : 'No location'} />
		</gridLayout>
	);
}
