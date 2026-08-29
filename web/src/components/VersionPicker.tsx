import type { Version } from '../types';

/**
 * Which ezmuze build the reporter is on. The list is registered by the
 * publishing pipeline, so it grows without a deploy.
 *
 * A value that is not in the list is still offered as an option: bugs raised
 * before this picker existed, and bugs raised through the API by something that
 * knows its own build string, would otherwise lose their version on the next
 * save.
 */
export function VersionPicker({
  id,
  value,
  versions,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  versions: Version[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const known = versions.some((v) => v.name === value);

  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not sure</option>
      {versions.map((v) => (
        <option key={v.id} value={v.name}>
          {v.name}
        </option>
      ))}
      {value && !known ? <option value={value}>{value}</option> : null}
    </select>
  );
}
