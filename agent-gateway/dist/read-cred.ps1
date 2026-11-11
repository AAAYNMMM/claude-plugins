Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinCredNative {
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredReadW", CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("Advapi32.dll", SetLastError = true, EntryPoint = "CredFree")]
    public static extern void CredFree(IntPtr credentialPtr);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }
    public static byte[] Read(string target) {
        IntPtr ptr;
        if (CredRead(target, 1, 0, out ptr)) {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[cred.CredentialBlobSize];
            Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
            CredFree(ptr);
            return bytes;
        }
        return null;
    }
}
'@

$target = $args[0]
if (-not $target) { $target = 'gemini:antigravity' }
$bytes = [WinCredNative]::Read($target)
if ($bytes -ne $null) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [System.Text.Encoding]::UTF8.GetString($bytes)
}
