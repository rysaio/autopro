// ============================================================
// Threat Intelligence Knowledge Base for SecOps Agent
// ============================================================

export interface MitreAttackTechnique {
  id: string;
  name: string;
  tactic: string;
  description: string;
  platforms: string[];
  dataSources: string[];
  detection: string;
  mitigation: string;
}

export interface ThreatIntelEntry {
  type: "ip" | "domain" | "hash" | "url" | "asn" | "port";
  value: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  description: string;
  mitreTechniques: string[];
  firstSeen: string;
  tags: string[];
}

export interface AlertTriagePlaybook {
  alertType: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  mitreTechniques: string[];
  steps: TriageStep[];
  escalationCriteria: string[];
  containmentActions: string[];
  investigationQuestions: string[];
}

export interface TriageStep {
  order: number;
  action: string;
  tool: string;
  expectedOutcome: string;
  timeAllocation: string;
}

// ============================================================
// MITRE ATT&CK Technique Database (50+ techniques)
// ============================================================

export const mitreAttackTechniques: MitreAttackTechnique[] = [
  // ---------- Reconnaissance ----------
  {
    id: "T1595", name: "Active Scanning", tactic: "reconnaissance",
    description: "Adversaries may execute active reconnaissance scans to gather information about victim systems.",
    platforms: ["pre-attack"], dataSources: ["network_traffic", "firewall_logs"],
    detection: "Monitor for unusual scanning activity from external IPs targeting multiple ports or services.",
    mitigation: "Implement network segmentation and limit exposed services. Use IDS/IPS to detect scan patterns."
  },
  {
    id: "T1592", name: "Gather Victim Host Information", tactic: "reconnaissance",
    description: "Adversaries may gather information about the victim's hosts for targeting.",
    platforms: ["pre-attack"], dataSources: ["dns", "internet_scan"],
    detection: "Monitor DNS queries for subdomain enumeration and information gathering patterns.",
    mitigation: "Minimize publicly exposed information about internal host configurations."
  },
  // ---------- Initial Access ----------
  {
    id: "T1190", name: "Exploit Public-Facing Application", tactic: "initial-access",
    description: "Adversaries attempt to exploit vulnerabilities in internet-facing applications.",
    platforms: ["Windows", "Linux", "macOS", "IaaS"],
    dataSources: ["web_logs", "waf_logs", "application_logs", "network_intrusion_detection"],
    detection: "Monitor web application logs for exploit patterns, unusual request payloads, and error spikes.",
    mitigation: "Regular vulnerability scanning, patch management, WAF deployment, and application hardening."
  },
  {
    id: "T1133", name: "External Remote Services", tactic: "initial-access",
    description: "Adversaries leverage external-facing remote services (VPN, RDP, SSH) to gain initial access.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["authentication_logs", "vpn_logs", "network_traffic"],
    detection: "Monitor for unusual authentication patterns, logins from new geolocations, and off-hours activity.",
    mitigation: "Enforce MFA, disable unused remote services, use IP allowlisting, and monitor for brute force."
  },
  {
    id: "T1566", name: "Phishing", tactic: "initial-access",
    description: "Adversaries send phishing emails to gain initial access via malicious attachments or links.",
    platforms: ["Windows", "Linux", "macOS", "SaaS"],
    dataSources: ["email_gateway", "endpoint_detection", "dns_logs"],
    detection: "Monitor email gateway for known malicious senders, suspicious attachments, and URL patterns.",
    mitigation: "Anti-phishing training, email filtering, attachment sandboxing, DMARC/DKIM/SPF enforcement."
  },
  {
    id: "T1078", name: "Valid Accounts", tactic: "initial-access",
    description: "Adversaries use stolen or compromised credentials for initial access.",
    platforms: ["Windows", "Linux", "macOS", "SaaS", "IaaS"],
    dataSources: ["authentication_logs", "identity_provider", "audit_logs"],
    detection: "Monitor for impossible travel, unusual login times, and access from suspicious IPs.",
    mitigation: "MFA enforcement, password policies, account monitoring, and privileged access management."
  },
  {
    id: "T1189", name: "Drive-by Compromise", tactic: "initial-access",
    description: "Adversaries compromise websites frequently visited by targets to deliver exploits.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["proxy_logs", "dns_logs", "endpoint_detection"],
    detection: "Monitor web proxy logs for connections to newly registered or compromised domains.",
    mitigation: "Web filtering, browser isolation, endpoint protection, and user awareness training."
  },
  {
    id: "T1199", name: "Trusted Relationship", tactic: "initial-access",
    description: "Adversaries breach third-party vendors or partners to gain access to the target network.",
    platforms: ["Windows", "Linux", "macOS", "SaaS"],
    dataSources: ["authentication_logs", "network_traffic", "third_party_logs"],
    detection: "Monitor third-party access patterns, unusual data transfers from partner connections.",
    mitigation: "Third-party risk assessments, network segmentation for partner access, and access auditing."
  },
  // ---------- Execution ----------
  {
    id: "T1059", name: "Command and Scripting Interpreter", tactic: "execution",
    description: "Adversaries abuse command and script interpreters (PowerShell, CMD, bash, Python) to execute commands.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "command_line", "script_block_logging"],
    detection: "Monitor for suspicious command-line arguments, encoded commands, and script execution from unusual locations.",
    mitigation: "Enable PowerShell logging, script block logging, and restrict scripting engine usage."
  },
  {
    id: "T1203", name: "Exploitation for Client Execution", tactic: "execution",
    description: "Adversaries exploit client application vulnerabilities to execute code.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["application_logs", "process_creation"],
    detection: "Monitor for unexpected application crashes and child processes spawned by client applications.",
    mitigation: "Regular application patching, application allowlisting, and endpoint protection."
  },
  {
    id: "T1204", name: "User Execution", tactic: "execution",
    description: "Adversaries rely on users to execute malicious content (macros, LNK files, etc.).",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "file_monitoring", "office_activity"],
    detection: "Monitor for Office applications spawning unusual child processes like cmd.exe or powershell.exe.",
    mitigation: "Disable macros by default, user awareness training, and mark-of-the-web enforcement."
  },
  {
    id: "T1047", name: "Windows Management Instrumentation", tactic: "execution",
    description: "Adversaries use WMI to execute commands and payloads for lateral movement and persistence.",
    platforms: ["Windows"], dataSources: ["wmi_logs", "process_creation", "command_line"],
    detection: "Monitor WMI event subscriptions and process creation via wmiprvse.exe.",
    mitigation: "Restrict WMI permissions, monitor WMI activity, and disable unnecessary WMI features."
  },
  {
    id: "T1053", name: "Scheduled Task/Job", tactic: "execution",
    description: "Adversaries use scheduled tasks for execution, persistence, and privilege escalation.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["scheduled_task_logs", "process_creation", "command_line"],
    detection: "Monitor for newly created scheduled tasks, especially those running from unusual paths.",
    mitigation: "Audit scheduled task creation, restrict task creation privileges, and monitor task changes."
  },
  // ---------- Persistence ----------
  {
    id: "T1547", name: "Boot or Logon Autostart Execution", tactic: "persistence",
    description: "Adversaries configure system settings to automatically execute programs during boot or logon.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["registry", "file_monitoring", "process_creation"],
    detection: "Monitor registry Run keys, Startup folder, and launchd/init.d for unauthorized entries.",
    mitigation: "Limit registry write permissions, monitor startup locations, and use application allowlisting."
  },
  {
    id: "T1543", name: "Create or Modify System Process", tactic: "persistence",
    description: "Adversaries create or modify system-level processes (services, daemons) for persistence.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["service_creation", "process_creation", "file_monitoring"],
    detection: "Monitor for new service creation and modifications to existing service binaries or configurations.",
    mitigation: "Restrict service creation permissions, audit service changes, and monitor critical system paths."
  },
  {
    id: "T1546", name: "Event Triggered Execution", tactic: "persistence",
    description: "Adversaries establish persistence via event triggers (WMI, screensaver, etc.).",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["wmi_logs", "file_monitoring", "registry"],
    detection: "Monitor for WMI permanent event subscriptions and unusual event trigger configurations.",
    mitigation: "Audit WMI subscriptions, restrict event trigger creation, and monitor system configuration changes."
  },
  {
    id: "T1136", name: "Create Account", tactic: "persistence",
    description: "Adversaries create local or domain accounts to maintain access.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["account_creation_logs", "authentication_logs", "audit_logs"],
    detection: "Monitor for account creation events, especially privileged accounts or accounts added to admin groups.",
    mitigation: "Audit account creation, enforce account creation approval workflows, and monitor privileged groups."
  },
  {
    id: "T1505", name: "Server Software Component", tactic: "persistence",
    description: "Adversaries abuse server software components (web shells, SQL stored procedures) for persistence.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["web_logs", "file_monitoring", "database_logs"],
    detection: "Monitor web server directories for new or modified files, and unusual database procedures.",
    mitigation: "Web application firewall, file integrity monitoring, and principle of least privilege."
  },
  // ---------- Privilege Escalation ----------
  {
    id: "T1068", name: "Exploitation for Privilege Escalation", tactic: "privilege-escalation",
    description: "Adversaries exploit software vulnerabilities to elevate privileges.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "kernel_logs", "vulnerability_scans"],
    detection: "Monitor for unusual process privilege escalation and kernel exploit attempts.",
    mitigation: "Regular patching, endpoint protection, and principle of least privilege."
  },
  {
    id: "T1055", name: "Process Injection", tactic: "privilege-escalation",
    description: "Adversaries inject code into processes to evade defenses and escalate privileges.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "api_monitoring", "endpoint_detection"],
    detection: "Monitor for unusual cross-process memory operations and API calls related to process injection.",
    mitigation: "Endpoint detection and response (EDR), application allowlisting, and behavior monitoring."
  },
  {
    id: "T1548", name: "Abuse Elevation Control Mechanism", tactic: "privilege-escalation",
    description: "Adversaries bypass UAC, sudo, and other elevation control mechanisms.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "command_line", "authentication_logs"],
    detection: "Monitor for UAC bypass techniques, sudo abuse patterns, and unusual elevation events.",
    mitigation: "Enforce UAC maximum settings, monitor sudo usage, and restrict elevation mechanisms."
  },
  {
    id: "T1134", name: "Access Token Manipulation", tactic: "privilege-escalation",
    description: "Adversaries manipulate access tokens to impersonate users and escalate privileges.",
    platforms: ["Windows"], dataSources: ["process_creation", "api_monitoring"],
    detection: "Monitor for token manipulation API calls and process creation with impersonated tokens.",
    mitigation: "Limit token manipulation permissions, monitor for SeDebugPrivilege abuse, and use EDR."
  },
  // ---------- Defense Evasion ----------
  {
    id: "T1070", name: "Indicator Removal", tactic: "defense-evasion",
    description: "Adversaries delete or modify artifacts to remove indicators of compromise.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "audit_logs"],
    detection: "Monitor for log clearing commands, file deletion patterns, and timestamp manipulation.",
    mitigation: "Centralized log collection, file integrity monitoring, and tamper-proof logging."
  },
  {
    id: "T1562", name: "Impair Defenses", tactic: "defense-evasion",
    description: "Adversaries disable or modify security tools to evade detection.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["service_monitoring", "process_creation", "registry"],
    detection: "Monitor for security service stoppage, AV/EDR tampering, and firewall rule modifications.",
    mitigation: "Tamper protection on security tools, service monitoring, and alert on security tool changes."
  },
  {
    id: "T1027", name: "Obfuscated Files or Information", tactic: "defense-evasion",
    description: "Adversaries obfuscate files, scripts, or payloads to evade signature-based detection.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "network_traffic"],
    detection: "Monitor for high entropy files, base64-encoded commands, and packed executables.",
    mitigation: "Behavior-based detection, sandboxing, and deep content inspection."
  },
  {
    id: "T1036", name: "Masquerading", tactic: "defense-evasion",
    description: "Adversaries disguise malicious executables or files as legitimate ones.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "digital_certificate_logs"],
    detection: "Monitor for executables in unusual locations, file name mismatches, and invalid signatures.",
    mitigation: "Application allowlisting, digital signature verification, and file integrity monitoring."
  },
  {
    id: "T1140", name: "Deobfuscate/Decode Files or Information", tactic: "defense-evasion",
    description: "Adversaries deobfuscate or decode encoded payloads at runtime.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "command_line", "script_block_logging"],
    detection: "Monitor for decoding/decompression commands and encoded payload execution.",
    mitigation: "Script logging, behavior monitoring, and endpoint detection."
  },
  {
    id: "T1218", name: "System Binary Proxy Execution", tactic: "defense-evasion",
    description: "Adversaries use signed system binaries (LOLBins) to proxy execution of malicious code.",
    platforms: ["Windows"], dataSources: ["process_creation", "command_line", "sysmon"],
    detection: "Monitor for LOLBin usage patterns, especially with network connections or file downloads.",
    mitigation: "Application control, LOLBin monitoring, and restricting unnecessary system binaries."
  },
  // ---------- Credential Access ----------
  {
    id: "T1003", name: "OS Credential Dumping", tactic: "credential-access",
    description: "Adversaries attempt to dump credentials from the operating system (LSASS, SAM, etc.).",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "api_monitoring", "file_access"],
    detection: "Monitor for LSASS access, SAM database reads, and credential dumping tool signatures.",
    mitigation: "Credential Guard, LSA protection, and restricting debug privileges."
  },
  {
    id: "T1552", name: "Unsecured Credentials", tactic: "credential-access",
    description: "Adversaries search for credentials stored insecurely (files, scripts, configs).",
    platforms: ["Windows", "Linux", "macOS", "IaaS", "SaaS"],
    dataSources: ["file_monitoring", "command_line", "process_creation"],
    detection: "Monitor for access to credential files, configuration files, and password storage locations.",
    mitigation: "Credential management solutions, secret scanning, and developer security training."
  },
  {
    id: "T1110", name: "Brute Force", tactic: "credential-access",
    description: "Adversaries use brute force techniques to guess passwords.",
    platforms: ["Windows", "Linux", "macOS", "SaaS", "IaaS"],
    dataSources: ["authentication_logs", "vpn_logs", "application_logs"],
    detection: "Monitor for multiple failed authentication attempts, account lockouts, and password spraying patterns.",
    mitigation: "Account lockout policies, MFA, strong password policies, and rate limiting."
  },
  {
    id: "T1555", name: "Credentials from Password Stores", tactic: "credential-access",
    description: "Adversaries extract credentials from password managers and browser stores.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "api_monitoring"],
    detection: "Monitor for access to browser credential stores and password manager databases.",
    mitigation: "Enterprise password management, restricting local credential storage, and EDR."
  },
  {
    id: "T1040", name: "Network Sniffing", tactic: "credential-access",
    description: "Adversaries sniff network traffic to capture credentials.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "process_creation", "network_interface_monitoring"],
    detection: "Monitor for promiscuous mode network interfaces and packet capture tools.",
    mitigation: "Encrypt network traffic, network segmentation, and monitor for sniffing tools."
  },
  {
    id: "T1539", name: "Steal Web Session Cookie", tactic: "credential-access",
    description: "Adversaries steal web session cookies to bypass authentication.",
    platforms: ["Windows", "Linux", "macOS", "SaaS"],
    dataSources: ["file_monitoring", "process_creation", "web_proxy_logs"],
    detection: "Monitor for access to browser cookie databases and unusual session token usage.",
    mitigation: "Session token binding, short session timeouts, and MFA for sensitive operations."
  },
  // ---------- Discovery ----------
  {
    id: "T1082", name: "System Information Discovery", tactic: "discovery",
    description: "Adversaries gather system information to understand the compromised environment.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "command_line"],
    detection: "Monitor for systeminfo, hostname, uname, and other system enumeration commands.",
    mitigation: "Monitor command execution patterns and restrict unnecessary system enumeration tools."
  },
  {
    id: "T1046", name: "Network Service Discovery", tactic: "discovery",
    description: "Adversaries scan for network services to identify targets for lateral movement.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "process_creation", "firewall_logs"],
    detection: "Monitor for internal port scanning activity and unusual network connection patterns.",
    mitigation: "Network segmentation, internal firewalls, and network monitoring."
  },
  {
    id: "T1083", name: "File and Directory Discovery", tactic: "discovery",
    description: "Adversaries enumerate files and directories to locate sensitive data.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "command_line", "file_access_logs"],
    detection: "Monitor for recursive directory listing commands and unusual file access patterns.",
    mitigation: "Data classification, access controls, and file access auditing."
  },
  {
    id: "T1087", name: "Account Discovery", tactic: "discovery",
    description: "Adversaries enumerate user and domain accounts on compromised systems.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "command_line", "api_monitoring"],
    detection: "Monitor for net user, net group, ldap queries, and other account enumeration commands.",
    mitigation: "Restrict account enumeration, monitor AD queries, and use deception technology."
  },
  {
    id: "T1069", name: "Permission Groups Discovery", tactic: "discovery",
    description: "Adversaries enumerate permission groups to identify high-value targets.",
    platforms: ["Windows", "Linux", "macOS", "SaaS"],
    dataSources: ["process_creation", "command_line", "api_monitoring"],
    detection: "Monitor for domain group enumeration and privileged group membership queries.",
    mitigation: "Monitor AD queries and restrict unnecessary group enumeration."
  },
  {
    id: "T1018", name: "Remote System Discovery", tactic: "discovery",
    description: "Adversaries discover remote systems on the network for lateral movement.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "process_creation", "firewall_logs"],
    detection: "Monitor for net view, ping sweeps, and ARP scanning activity.",
    mitigation: "Network segmentation, disable NetBIOS where not needed, and monitor network scans."
  },
  // ---------- Lateral Movement ----------
  {
    id: "T1021", name: "Remote Services", tactic: "lateral-movement",
    description: "Adversaries use remote services (RDP, SSH, SMB, WinRM) to move laterally.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["authentication_logs", "network_traffic", "process_creation"],
    detection: "Monitor for unusual remote service connections and lateral movement patterns.",
    mitigation: "Network segmentation, restrict remote services, and enforce MFA for remote access."
  },
  {
    id: "T1550", name: "Use Alternate Authentication Material", tactic: "lateral-movement",
    description: "Adversaries use stolen tokens, tickets, or hashes to authenticate without passwords.",
    platforms: ["Windows"], dataSources: ["authentication_logs", "windows_event_logs"],
    detection: "Monitor for Pass-the-Hash, Pass-the-Ticket, and Golden Ticket activity.",
    mitigation: "Credential Guard, frequent KRBTGT password rotation, and monitor for token anomalies."
  },
  {
    id: "T1210", name: "Exploitation of Remote Services", tactic: "lateral-movement",
    description: "Adversaries exploit vulnerabilities in remote services to move laterally.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "vulnerability_scans", "exploit_detection"],
    detection: "Monitor for exploit patterns targeting SMB, RDP, SSH, and other remote services.",
    mitigation: "Regular patching, network segmentation, and vulnerability management."
  },
  {
    id: "T1570", name: "Lateral Tool Transfer", tactic: "lateral-movement",
    description: "Adversaries transfer tools between systems to facilitate lateral movement.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "network_traffic", "process_creation"],
    detection: "Monitor for file sharing connections, admin share access, and tool transfer patterns.",
    mitigation: "Restrict admin shares, monitor file transfers, and use network segmentation."
  },
  {
    id: "T1563", name: "Remote Service Session Hijacking", tactic: "lateral-movement",
    description: "Adversaries hijack legitimate remote service sessions to move laterally.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["session_logs", "authentication_logs", "process_creation"],
    detection: "Monitor for session hijacking indicators and unusual session reuse.",
    mitigation: "Session timeouts, re-authentication requirements, and session monitoring."
  },
  // ---------- Collection ----------
  {
    id: "T1560", name: "Archive Collected Data", tactic: "collection",
    description: "Adversaries compress and encrypt collected data prior to exfiltration.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "command_line"],
    detection: "Monitor for archiving tools (rar, 7z, zip) used on sensitive data directories.",
    mitigation: "Data loss prevention (DLP), file activity monitoring, and restricting archiving tools."
  },
  {
    id: "T1113", name: "Screen Capture", tactic: "collection",
    description: "Adversaries capture screenshots of the victim's desktop.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "api_monitoring"],
    detection: "Monitor for screen capture API calls and screenshot tool execution.",
    mitigation: "Application allowlisting, restricting screen capture APIs, and EDR."
  },
  {
    id: "T1005", name: "Data from Local System", tactic: "collection",
    description: "Adversaries collect sensitive data from local systems.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "command_line"],
    detection: "Monitor for bulk file access and copying from sensitive directories.",
    mitigation: "Data classification, access controls, and file access auditing."
  },
  {
    id: "T1114", name: "Email Collection", tactic: "collection",
    description: "Adversaries collect email data from local clients or servers.",
    platforms: ["Windows", "Linux", "macOS", "SaaS"],
    dataSources: ["email_server_logs", "file_monitoring", "process_creation"],
    detection: "Monitor for unusual email access patterns and PST/OST file access.",
    mitigation: "Email encryption, access controls, and monitoring for bulk email export."
  },
  {
    id: "T1125", name: "Video Capture", tactic: "collection",
    description: "Adversaries capture video from connected cameras.",
    platforms: ["Windows", "macOS"], dataSources: ["process_creation", "api_monitoring"],
    detection: "Monitor for camera access API calls and video capture tool execution.",
    mitigation: "Physical camera covers, camera access policies, and EDR monitoring."
  },
  // ---------- Command and Control ----------
  {
    id: "T1071", name: "Application Layer Protocol", tactic: "command-and-control",
    description: "Adversaries use standard application layer protocols (HTTP/HTTPS, DNS, SMB) for C2.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "proxy_logs", "dns_logs"],
    detection: "Monitor for unusual traffic patterns, beaconing behavior, and anomalous protocol usage.",
    mitigation: "Network traffic analysis, proxy filtering, and DNS sinkholing."
  },
  {
    id: "T1573", name: "Encrypted Channel", tactic: "command-and-control",
    description: "Adversaries encrypt C2 communications using standard or custom protocols.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "tls_inspection"],
    detection: "Monitor for unusual TLS certificate attributes, JA3/JA4 fingerprints, and encrypted beaconing.",
    mitigation: "TLS inspection, network monitoring, and blocking known C2 infrastructure."
  },
  {
    id: "T1105", name: "Ingress Tool Transfer", tactic: "command-and-control",
    description: "Adversaries transfer tools or files from external systems to compromised hosts.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "file_monitoring", "proxy_logs"],
    detection: "Monitor for downloads from newly registered domains, unusual file types, and download tools.",
    mitigation: "Web filtering, file type restrictions, and network monitoring."
  },
  {
    id: "T1095", name: "Non-Application Layer Protocol", tactic: "command-and-control",
    description: "Adversaries use non-standard protocols (ICMP, UDP, custom TCP) for C2.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "firewall_logs", "netflow"],
    detection: "Monitor for unusual protocol usage, non-standard ports, and protocol tunneling.",
    mitigation: "Egress filtering, protocol allowlisting, and deep packet inspection."
  },
  {
    id: "T1571", name: "Non-Standard Port", tactic: "command-and-control",
    description: "Adversaries use non-standard ports for C2 communication.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "firewall_logs", "netflow"],
    detection: "Monitor for connections to unusual or high-numbered ports, especially with beaconing patterns.",
    mitigation: "Egress filtering, port allowlisting, and network monitoring."
  },
  {
    id: "T1102", name: "Web Service", tactic: "command-and-control",
    description: "Adversaries use legitimate web services (social media, cloud storage, paste sites) for C2.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["proxy_logs", "dns_logs", "network_traffic"],
    detection: "Monitor for connections to web services used atypically by the organization.",
    mitigation: "Web filtering, cloud service monitoring, and CASB solutions."
  },
  // ---------- Exfiltration ----------
  {
    id: "T1048", name: "Exfiltration Over Alternative Protocol", tactic: "exfiltration",
    description: "Adversaries exfiltrate data over protocols other than their primary C2 channel.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "firewall_logs", "netflow"],
    detection: "Monitor for large outbound data transfers over unusual protocols and ports.",
    mitigation: "Egress filtering, DLP, and network traffic analysis."
  },
  {
    id: "T1567", name: "Exfiltration Over Web Service", tactic: "exfiltration",
    description: "Adversaries exfiltrate data to cloud storage, paste sites, and other web services.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["proxy_logs", "network_traffic", "dns_logs"],
    detection: "Monitor for large uploads to cloud storage services and unusual web service connections.",
    mitigation: "CASB, DLP, cloud service restrictions, and web filtering."
  },
  {
    id: "T1020", name: "Automated Exfiltration", tactic: "exfiltration",
    description: "Adversaries automate data exfiltration using scheduled transfers or triggers.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "scheduled_task_logs", "file_monitoring"],
    detection: "Monitor for scheduled data transfers, automated uploads, and exfiltration patterns.",
    mitigation: "DLP, egress filtering, and monitoring for scheduled data transfers."
  },
  {
    id: "T1030", name: "Data Transfer Size Limits", tactic: "exfiltration",
    description: "Adversaries chunk exfiltrated data into small pieces to evade detection.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "proxy_logs"],
    detection: "Monitor for patterns of small, consistent data transfers over time.",
    mitigation: "Network traffic analysis, DLP, and behavioral analytics."
  },
  {
    id: "T1041", name: "Exfiltration Over C2 Channel", tactic: "exfiltration",
    description: "Adversaries exfiltrate data over their established C2 channel.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["network_traffic", "proxy_logs", "netflow"],
    detection: "Monitor for asymmetric traffic patterns (more outbound than inbound) and large data transfers.",
    mitigation: "Network monitoring, DLP, and C2 channel disruption."
  },
  // ---------- Impact ----------
  {
    id: "T1486", name: "Data Encrypted for Impact", tactic: "impact",
    description: "Adversaries encrypt data on target systems to disrupt availability (ransomware).",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "file_system_logs"],
    detection: "Monitor for mass file encryption, ransomware notes, and file extension changes.",
    mitigation: "Regular backups, endpoint protection, file integrity monitoring, and access controls."
  },
  {
    id: "T1490", name: "Inhibit System Recovery", tactic: "impact",
    description: "Adversaries disable or delete system recovery features to prevent recovery.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["process_creation", "command_line", "file_monitoring"],
    detection: "Monitor for deletion of shadow copies, backup deletion, and recovery tool disabling.",
    mitigation: "Offline backups, backup protection, and monitoring for recovery feature tampering."
  },
  {
    id: "T1485", name: "Data Destruction", tactic: "impact",
    description: "Adversaries destroy data to disrupt operations (wiper malware).",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "process_creation", "file_system_logs"],
    detection: "Monitor for mass file deletion, disk wiping utilities, and MBR/VBR modification.",
    mitigation: "Offline backups, endpoint protection, and monitoring for destructive tools."
  },
  {
    id: "T1489", name: "Service Stop", tactic: "impact",
    description: "Adversaries stop critical services to disrupt operations.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["service_monitoring", "process_creation", "windows_event_logs"],
    detection: "Monitor for critical service stoppage, especially database, web, and security services.",
    mitigation: "Service monitoring, auto-restart policies, and restricting service control permissions."
  },
  {
    id: "T1498", name: "Network Denial of Service", tactic: "impact",
    description: "Adversaries perform network DoS attacks to disrupt availability.",
    platforms: ["Windows", "Linux", "macOS", "IaaS"],
    dataSources: ["network_traffic", "firewall_logs", "netflow"],
    detection: "Monitor for traffic spikes, SYN floods, and amplification attack patterns.",
    mitigation: "DDoS protection, rate limiting, and network capacity planning."
  },
  {
    id: "T1491", name: "Defacement", tactic: "impact",
    description: "Adversaries modify visual content to deliver messages or cause reputational damage.",
    platforms: ["Windows", "Linux", "macOS"],
    dataSources: ["file_monitoring", "web_logs", "process_creation"],
    detection: "Monitor for unauthorized modifications to web content and public-facing resources.",
    mitigation: "Web content integrity monitoring, access controls, and change management."
  }
];

// ============================================================
// Threat Intelligence Knowledge Base
// ============================================================

export const threatIntelKnowledgeBase: ThreatIntelEntry[] = [
  // Documentation IP Ranges
  { type: "ip", value: "192.0.2.0/24", category: "documentation", severity: "low", description: "TEST-NET-1 address block per RFC 5737. Reserved for documentation and examples.", mitreTechniques: [], firstSeen: "N/A", tags: ["documentation", "test-net", "rfc5737"] },
  { type: "ip", value: "203.0.113.0/24", category: "documentation", severity: "low", description: "TEST-NET-3 address block per RFC 5737. Reserved for documentation and examples.", mitreTechniques: [], firstSeen: "N/A", tags: ["documentation", "test-net", "rfc5737"] },
  { type: "ip", value: "198.51.100.45", category: "documentation", severity: "low", description: "TEST-NET-2 address block per RFC 5737. Reserved for documentation.", mitreTechniques: [], firstSeen: "N/A", tags: ["documentation", "test-net", "rfc5737"] },
  // Known Malicious IPs
  { type: "ip", value: "185.130.5.253", category: "c2", severity: "critical", description: "Known Cobalt Strike C2 server associated with ransomware campaigns.", mitreTechniques: ["T1071", "T1573", "T1105"], firstSeen: "2024-01-15", tags: ["cobalt-strike", "ransomware", "c2"] },
  { type: "ip", value: "45.155.205.233", category: "c2", severity: "high", description: "Emotet botnet C2 infrastructure node.", mitreTechniques: ["T1071", "T1566", "T1105"], firstSeen: "2024-03-22", tags: ["emotet", "botnet", "c2", "banking-trojan"] },
  { type: "ip", value: "103.224.182.241", category: "phishing", severity: "high", description: "Phishing campaign landing page hosting credential harvesting forms.", mitreTechniques: ["T1566", "T1078"], firstSeen: "2024-05-10", tags: ["phishing", "credential-harvesting", "landing-page"] },
  { type: "ip", value: "194.61.121.68", category: "c2", severity: "high", description: "IcedID/BokBot malware C2 server.", mitreTechniques: ["T1071", "T1105", "T1003"], firstSeen: "2024-02-14", tags: ["icedid", "bokbot", "banking-trojan", "c2"] },
  { type: "ip", value: "91.240.118.172", category: "c2", severity: "high", description: "QakBot/QBot malware C2 infrastructure.", mitreTechniques: ["T1071", "T1566", "T1021"], firstSeen: "2024-04-01", tags: ["qakbot", "qbot", "c2", "banking-trojan"] },
  { type: "ip", value: "5.255.100.45", category: "c2", severity: "critical", description: "TrickBot malware C2 server associated with Ryuk ransomware deployment.", mitreTechniques: ["T1071", "T1105", "T1486", "T1021"], firstSeen: "2024-01-28", tags: ["trickbot", "ryuk", "ransomware", "c2"] },
  // Known Malicious Domains
  { type: "domain", value: "evil-update-server.com", category: "c2", severity: "critical", description: "Fake update server used by APT29 to distribute malware via software supply chain.", mitreTechniques: ["T1195", "T1071", "T1105"], firstSeen: "2024-01-10", tags: ["apt29", "supply-chain", "c2", "nation-state"] },
  { type: "domain", value: "secure-docs-share.xyz", category: "phishing", severity: "high", description: "Phishing domain impersonating document sharing services to steal credentials.", mitreTechniques: ["T1566", "T1078"], firstSeen: "2024-06-15", tags: ["phishing", "credential-harvesting", "business-email-compromise"] },
  { type: "domain", value: "vpn-portal-update.net", category: "phishing", severity: "high", description: "Fake VPN portal used for credential harvesting targeting remote workers.", mitreTechniques: ["T1566", "T1078", "T1133"], firstSeen: "2024-04-20", tags: ["phishing", "vpn", "credential-harvesting", "remote-access"] },
  { type: "domain", value: "cdn-update-cache.org", category: "c2", severity: "high", description: "Domain used for Cobalt Strike Malleable C2 profile mimicking CDN traffic.", mitreTechniques: ["T1071", "T1573", "T1036"], firstSeen: "2024-03-05", tags: ["cobalt-strike", "c2", "malleable-c2", "cdn-mimic"] },
  { type: "domain", value: "office365-verify-auth.com", category: "phishing", severity: "high", description: "Microsoft 365 credential harvesting phishing page.", mitreTechniques: ["T1566", "T1078", "T1552"], firstSeen: "2024-05-30", tags: ["phishing", "office365", "credential-harvesting", "impersonation"] },
  { type: "domain", value: "cloud-backup-sync.top", category: "exfiltration", severity: "high", description: "Domain used for data exfiltration via cloud storage API impersonation.", mitreTechniques: ["T1567", "T1048", "T1020"], firstSeen: "2024-02-28", tags: ["exfiltration", "cloud-storage", "data-theft"] },
  { type: "domain", value: "sysupdate-patch.biz", category: "c2", severity: "high", description: "BumbleBee loader C2 domain impersonating system update services.", mitreTechniques: ["T1071", "T1105", "T1036"], firstSeen: "2024-04-12", tags: ["bumblebee", "loader", "c2", "impersonation"] },
  { type: "domain", value: "dns-resolver-cache.info", category: "c2", severity: "high", description: "DNS tunneling C2 domain used by APT groups for covert communication.", mitreTechniques: ["T1071", "T1573", "T1048"], firstSeen: "2024-01-20", tags: ["dns-tunneling", "apt", "c2", "covert-channel"] },
  { type: "domain", value: "payroll-invoice-reminder.live", category: "phishing", severity: "high", description: "Business email compromise (BEC) phishing domain targeting finance departments.", mitreTechniques: ["T1566", "T1078"], firstSeen: "2024-06-01", tags: ["bec", "phishing", "finance", "invoice-fraud"] },
  { type: "domain", value: "secure-file-transfer.icu", category: "phishing", severity: "medium", description: "Fake secure file transfer service used to deliver malware-laced attachments.", mitreTechniques: ["T1566", "T1204"], firstSeen: "2024-05-18", tags: ["phishing", "malware-delivery", "attachment"] },
  { type: "domain", value: "windows-defender-alert.cyou", category: "phishing", severity: "high", description: "Fake security alert page used for tech support scams and malware delivery.", mitreTechniques: ["T1566", "T1204"], firstSeen: "2024-04-25", tags: ["tech-support-scam", "phishing", "malware-delivery", "scareware"] },
  { type: "domain", value: "banking-secure-login.monster", category: "phishing", severity: "critical", description: "Banking credential harvesting domain targeting financial institutions.", mitreTechniques: ["T1566", "T1078", "T1555"], firstSeen: "2024-03-10", tags: ["phishing", "banking", "credential-harvesting", "financial-fraud"] },
  { type: "domain", value: "rce-exploit-poc.download", category: "exploit", severity: "high", description: "Domain hosting exploit PoC code that actually delivers malware to researchers.", mitreTechniques: ["T1189", "T1203", "T1105"], firstSeen: "2024-05-05", tags: ["exploit", "honeypot", "malware-delivery", "researcher-targeting"] },
  { type: "domain", value: "crypto-miner-pool.strangled.net", category: "cryptomining", severity: "medium", description: "Cryptojacking mining pool domain used by XMRig campaigns.", mitreTechniques: ["T1496", "T1071"], firstSeen: "2024-02-01", tags: ["cryptojacking", "mining", "xmrig", "resource-hijacking"] },
  // Known Malware Hashes
  { type: "hash", value: "d41d8cd98f00b204e9800998ecf8427e", category: "sample", severity: "low", description: "Sample empty file hash (MD5) - used for testing only.", mitreTechniques: [], firstSeen: "N/A", tags: ["sample", "testing", "md5"] },
  { type: "hash", value: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", category: "sample", severity: "low", description: "Sample empty file hash (SHA256) - used for testing only.", mitreTechniques: [], firstSeen: "N/A", tags: ["sample", "testing", "sha256"] },
  { type: "hash", value: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", category: "ransomware", severity: "critical", description: "Ryuk ransomware sample (SHA256) - encrypts files and drops ransom note.", mitreTechniques: ["T1486", "T1490", "T1485"], firstSeen: "2024-02-10", tags: ["ransomware", "ryuk", "encryption", "wizard-spider"] },
  { type: "hash", value: "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7", category: "trojan", severity: "high", description: "Emotet banking trojan loader (SHA256) - downloads additional modules.", mitreTechniques: ["T1105", "T1071", "T1003"], firstSeen: "2024-03-15", tags: ["emotet", "banking-trojan", "loader", "downloader"] },
  { type: "hash", value: "c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8", category: "c2", severity: "high", description: "Cobalt Strike beacon (SHA256) - default HTTPS beacon configuration.", mitreTechniques: ["T1071", "T1573", "T1055"], firstSeen: "2024-04-20", tags: ["cobalt-strike", "beacon", "c2", "post-exploitation"] },
  { type: "hash", value: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9", category: "infostealer", severity: "high", description: "RedLine Stealer sample (SHA256) - steals browser credentials and crypto wallets.", mitreTechniques: ["T1555", "T1003", "T1552"], firstSeen: "2024-05-10", tags: ["redline", "infostealer", "credential-theft", "crypto-wallet"] },
  { type: "hash", value: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", category: "loader", severity: "high", description: "BumbleBee loader (SHA256) - used to deliver Cobalt Strike and other payloads.", mitreTechniques: ["T1105", "T1071", "T1204"], firstSeen: "2024-04-01", tags: ["bumblebee", "loader", "payload-delivery", "initial-access"] },
  { type: "hash", value: "f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1", category: "ransomware", severity: "critical", description: "LockBit 3.0 ransomware encryptor (SHA256) - affiliate ransomware variant.", mitreTechniques: ["T1486", "T1490", "T1027"], firstSeen: "2024-01-25", tags: ["lockbit", "ransomware", "encryption", "ransomware-as-a-service"] },
  { type: "hash", value: "a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2", category: "backdoor", severity: "high", description: "Silver implant (APT29) - backdoor used for long-term persistence and C2.", mitreTechniques: ["T1547", "T1071", "T1573", "T1055"], firstSeen: "2024-02-18", tags: ["apt29", "silver", "backdoor", "nation-state", "persistence"] },
  { type: "hash", value: "b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3", category: "trojan", severity: "high", description: "IcedID banking trojan (SHA256) - modular banking trojan with web injects.", mitreTechniques: ["T1003", "T1071", "T1555", "T1055"], firstSeen: "2024-03-28", tags: ["icedid", "banking-trojan", "web-injects", "credential-theft"] },
  { type: "hash", value: "c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4", category: "c2", severity: "high", description: "Mythic C2 agent (SHA256) - Apollo agent for macOS post-exploitation.", mitreTechniques: ["T1071", "T1573", "T1059"], firstSeen: "2024-05-22", tags: ["mythic", "c2", "macos", "post-exploitation", "apollo"] },
  { type: "hash", value: "d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5", category: "ransomware", severity: "critical", description: "BlackCat/ALPHV ransomware (SHA256) - Rust-based ransomware with advanced features.", mitreTechniques: ["T1486", "T1490", "T1562", "T1027"], firstSeen: "2024-01-12", tags: ["blackcat", "alphv", "ransomware", "rust", "double-extortion"] },
  { type: "hash", value: "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6", category: "infostealer", severity: "medium", description: "Vidar infostealer (SHA256) - collects browser data, credentials, and cryptocurrency wallets.", mitreTechniques: ["T1555", "T1552", "T1539"], firstSeen: "2024-06-05", tags: ["vidar", "infostealer", "credential-theft", "malware-as-a-service"] },
  // Known Malicious URLs
  { type: "url", value: "https://evil-update-server.com/update/agent.exe", category: "malware-delivery", severity: "critical", description: "Malware delivery URL distributing a Cobalt Strike beacon payload.", mitreTechniques: ["T1105", "T1071", "T1204"], firstSeen: "2024-02-15", tags: ["malware-delivery", "cobalt-strike", "executable"] },
  { type: "url", value: "https://secure-docs-share.xyz/login.php", category: "phishing", severity: "high", description: "Credential harvesting phishing page impersonating SharePoint login.", mitreTechniques: ["T1566", "T1078"], firstSeen: "2024-06-15", tags: ["phishing", "credential-harvesting", "sharepoint", "impersonation"] },
  { type: "url", value: "https://cdn-update-cache.org/js/jquery.min.js", category: "c2", severity: "high", description: "Malleable C2 profile disguised as a jQuery CDN resource.", mitreTechniques: ["T1071", "T1573", "T1036"], firstSeen: "2024-03-05", tags: ["cobalt-strike", "malleable-c2", "cdn", "obfuscation"] },
  { type: "url", value: "https://office365-verify-auth.com/owa/auth", category: "phishing", severity: "high", description: "Microsoft 365 credential harvesting page mimicking OWA authentication.", mitreTechniques: ["T1566", "T1078", "T1552"], firstSeen: "2024-05-30", tags: ["phishing", "office365", "owa", "credential-harvesting"] },
  { type: "url", value: "https://cloud-backup-sync.top/api/upload", category: "exfiltration", severity: "high", description: "Data exfiltration endpoint accepting compressed archives of stolen data.", mitreTechniques: ["T1567", "T1048", "T1560"], firstSeen: "2024-02-28", tags: ["exfiltration", "data-theft", "api", "cloud"] },
  { type: "url", value: "https://payroll-invoice-reminder.live/Invoice_2024_Q3.docm", category: "phishing", severity: "high", description: "Malicious Word document with macros delivering BumbleBee loader.", mitreTechniques: ["T1566", "T1204", "T1059"], firstSeen: "2024-06-01", tags: ["phishing", "macro", "bumblebee", "malicious-document"] },
  { type: "url", value: "https://windows-defender-alert.cyou/scan/index.html", category: "phishing", severity: "high", description: "Fake Windows Defender alert page leading to tech support scam.", mitreTechniques: ["T1566", "T1204"], firstSeen: "2024-04-25", tags: ["tech-support-scam", "scareware", "social-engineering"] },
  { type: "url", value: "https://banking-secure-login.monster/auth/verify", category: "phishing", severity: "critical", description: "Banking credential harvesting page with real-time phishing kit.", mitreTechniques: ["T1566", "T1078", "T1555", "T1110"], firstSeen: "2024-03-10", tags: ["phishing", "banking", "real-time-phishing", "mitm"] }
];

// ============================================================
// Suspicious Ports and ASN Patterns
// ============================================================

export const maliciousAsnPatterns = [
  { asn: "AS44477", name: "Stark Industries Solutions", risk: "high", note: "Bulletproof hosting provider frequently used by ransomware groups." },
  { asn: "AS200593", name: "ProtonVPN / Hosting", risk: "medium", note: "Often used for anonymization of malicious traffic." },
  { asn: "AS202425", name: "IP Volume Inc", risk: "high", note: "Bulletproof hosting associated with phishing and malware distribution." },
  { asn: "AS53667", name: "FranTech Solutions", risk: "medium", note: "Known for hosting C2 infrastructure and phishing sites." },
  { asn: "AS62240", name: "Clouvider / Hosting", risk: "medium", note: "Used in various credential harvesting campaigns." }
];

export const suspiciousPortPatterns = [
  { port: 4444, protocol: "tcp", risk: "high", note: "Common Metasploit/Meterpreter default listener port." },
  { port: 8080, protocol: "tcp", risk: "medium", note: "Often used for C2 HTTP proxies and web shells." },
  { port: 8443, protocol: "tcp", risk: "medium", note: "Alternative HTTPS C2 port, often with self-signed certificates." },
  { port: 50050, protocol: "tcp", risk: "high", note: "Cobalt Strike default team server port." },
  { port: 31337, protocol: "tcp", risk: "high", note: "Classic backdoor/Back Orifice port, frequently used by malware." },
  { port: 1337, protocol: "tcp", risk: "medium", note: "Commonly used by custom malware and CTF tools." },
  { port: 53, protocol: "udp", risk: "medium", note: "DNS tunneling - watch for anomalous DNS traffic patterns." },
  { port: 123, protocol: "udp", risk: "low", note: "NTP amplification - watch for unusual NTP traffic volume." }
];

export const geolocationRiskHints = [
  { country: "Russia (RU)", regions: ["Moscow", "Saint Petersburg"], risk: "elevated", note: "Common origin for APT29/Cozy Bear and ransomware operations." },
  { country: "China (CN)", regions: ["Shanghai", "Beijing", "Guangdong"], risk: "elevated", note: "Common origin for APT10/APT41 and state-sponsored intrusions." },
  { country: "North Korea (KP)", regions: [], risk: "high", note: "Common origin for Lazarus Group (APT38) and financial crime campaigns." },
  { country: "Iran (IR)", regions: ["Tehran"], risk: "elevated", note: "Common origin for APT33/APT34 and destructive attacks." },
  { country: "Nigeria (NG)", regions: ["Lagos"], risk: "medium", note: "Common origin for BEC and romance fraud campaigns." },
  { country: "Romania (RO)", regions: [], risk: "medium", note: "Common hosting location for phishing infrastructure and botnets." },
  { country: "Netherlands (NL)", regions: [], risk: "low", note: "Major hosting hub; benign traffic can be mixed with malicious." },
  { country: "United States (US)", regions: [], risk: "low", note: "Major hosting hub; isolate specific IP reputation rather than geo." },
  { country: "Ukraine (UA)", regions: [], risk: "medium", note: "Mixed reputation; some bulletproof hosting and ransomware operations." },
  { country: "Belarus (BY)", regions: [], risk: "medium", note: "Some bulletproof hosting and state-sponsored activity." }
];

// ============================================================
// Alert Triage Playbooks
// ============================================================

export const alertTriagePlaybooks: AlertTriagePlaybook[] = [
  {
    alertType: "brute_force", title: "Brute Force Attack Triage Playbook", severity: "high",
    mitreTechniques: ["T1110", "T1078", "T1133"],
    steps: [
      { order: 1, action: "Identify the target account and source IPs involved in the brute force attempt.", tool: "secops_ioc_enrich", expectedOutcome: "List of targeted accounts, source IPs, and authentication service (VPN, RDP, SSH, OWA).", timeAllocation: "5 minutes" },
      { order: 2, action: "Check asset inventory for affected systems and their criticality.", tool: "secops_asset_inventory_lookup", expectedOutcome: "Asset ownership, criticality, and business context for targeted systems.", timeAllocation: "5 minutes" },
      { order: 3, action: "Enrich source IPs with threat intelligence to determine if known malicious.", tool: "threat_intel_lookup", expectedOutcome: "Threat intelligence context for source IPs including known campaigns and TTPs.", timeAllocation: "5 minutes" },
      { order: 4, action: "Determine if any accounts were successfully compromised by checking successful logins from source IPs.", tool: "log_analysis", expectedOutcome: "List of any successful authentications from the attacking IPs.", timeAllocation: "10 minutes" },
      { order: 5, action: "Review affected account's recent activity for signs of post-compromise activity.", tool: "log_analysis", expectedOutcome: "Timeline of account activity including privilege changes, data access, and lateral movement.", timeAllocation: "15 minutes" },
      { order: 6, action: "Search for relevant detection rules and MITRE ATT&CK techniques.", tool: "mitre_attack_search", expectedOutcome: "Relevant MITRE techniques and detection guidance for brute force scenarios.", timeAllocation: "5 minutes" }
    ],
    escalationCriteria: ["Successful authentication from attacking IP address", "Targeted account has privileged access (domain admin, server admin, etc.)", "Brute force against multiple accounts across different departments", "Source IP associated with known APT group or ransomware affiliate", "Attack coincides with other suspicious activity (defense evasion, C2 beaconing)"],
    containmentActions: ["Immediately disable compromised accounts", "Force password reset for all affected accounts", "Block source IPs at firewall/IPS level", "Enable MFA for all affected accounts if not already enforced", "Review and revoke any sessions from the source IPs", "Notify affected users and security team"],
    investigationQuestions: ["Is this a targeted attack or opportunistic scanning?", "What authentication service was targeted (VPN, RDP, OWA, SSH)?", "Were any accounts successfully compromised?", "What is the criticality of the targeted accounts and systems?", "Are the source IPs associated with known threat actors?", "Is there evidence of credential stuffing vs. password spraying vs. dictionary attack?", "Has the affected account been used for lateral movement or data access?"]
  },
  {
    alertType: "malware", title: "Malware Infection Triage Playbook", severity: "critical",
    mitreTechniques: ["T1204", "T1059", "T1105", "T1071", "T1486"],
    steps: [
      { order: 1, action: "Identify the affected host, malware hash, and initial detection source.", tool: "secops_ioc_enrich", expectedOutcome: "Hostname, file hash, detection method (AV, EDR, network), and initial alert context.", timeAllocation: "5 minutes" },
      { order: 2, action: "Look up the malware hash in threat intelligence.", tool: "threat_intel_lookup", expectedOutcome: "Malware family identification, known TTPs, associated campaigns, and risk assessment.", timeAllocation: "5 minutes" },
      { order: 3, action: "Check asset criticality and business context.", tool: "secops_asset_inventory_lookup", expectedOutcome: "Asset owner, criticality, data classification, and containment guidance.", timeAllocation: "5 minutes" },
      { order: 4, action: "Isolate affected host immediately if critical asset or ransomware indicator.", tool: "edr_containment", expectedOutcome: "Host network isolation confirmed, containment status verified.", timeAllocation: "5 minutes" },
      { order: 5, action: "Collect process tree, network connections, and persistence mechanisms.", tool: "edr_forensics", expectedOutcome: "Full process ancestry, active network connections, autorun entries, and scheduled tasks.", timeAllocation: "15 minutes" },
      { order: 6, action: "Search for lateral movement indicators from affected host.", tool: "log_analysis", expectedOutcome: "Evidence of lateral movement (SMB connections, RDP sessions, WinRM, PSRemoting).", timeAllocation: "15 minutes" },
      { order: 7, action: "Review MITRE ATT&CK techniques for the malware family.", tool: "mitre_attack_search", expectedOutcome: "Full MITRE technique mapping with detection and mitigation guidance.", timeAllocation: "10 minutes" }
    ],
    escalationCriteria: ["Ransomware detected (immediate incident response activation)", "Malware on domain controller, file server, or database server", "Evidence of lateral movement to other systems", "Data exfiltration indicators present", "Malware associated with known APT group", "Multiple hosts affected across different network segments"],
    containmentActions: ["Isolate affected host(s) from network immediately", "Block associated C2 domains and IPs at network perimeter", "Disable affected user accounts pending investigation", "Collect forensic image of affected system(s)", "Block malware hash in EDR/AV across entire environment", "Review and revoke any credentials potentially exposed on affected host", "Notify incident response team and affected stakeholders"],
    investigationQuestions: ["How did the malware arrive on the system (phishing, drive-by, USB, supply chain)?", "What is the malware family and its known capabilities?", "Has the malware established persistence? If so, how?", "Is there evidence of C2 communication? What are the destinations?", "Has the malware been used to move laterally or access sensitive data?", "Are there any sibling alerts on other hosts?", "What is the timeline of the infection from initial access to detection?", "Were any credentials harvested from the affected system?"]
  },
  {
    alertType: "phishing", title: "Phishing Incident Triage Playbook", severity: "high",
    mitreTechniques: ["T1566", "T1078", "T1204"],
    steps: [
      { order: 1, action: "Extract and analyze phishing indicators (sender, subject, URLs, attachments).", tool: "secops_ioc_enrich", expectedOutcome: "IOC extraction: sender domain, embedded URLs, attachment hashes, and email headers.", timeAllocation: "10 minutes" },
      { order: 2, action: "Enrich extracted IOCs with threat intelligence.", tool: "threat_intel_lookup", expectedOutcome: "Reputation assessment for sender domain, URLs, and attachment hashes.", timeAllocation: "5 minutes" },
      { order: 3, action: "Identify all recipients of the phishing email.", tool: "email_gateway", expectedOutcome: "Full list of recipients, including those who opened, clicked, or reported the email.", timeAllocation: "10 minutes" },
      { order: 4, action: "Prioritize investigation of users who clicked links or opened attachments.", tool: "edr_forensics", expectedOutcome: "Endpoint analysis for users who interacted with the phishing content.", timeAllocation: "15 minutes" },
      { order: 5, action: "Check for credential harvesting by looking for unusual logins from recipient accounts.", tool: "log_analysis", expectedOutcome: "Unusual authentication events from potentially compromised accounts.", timeAllocation: "10 minutes" },
      { order: 6, action: "Search for detection rules and MITRE techniques related to phishing.", tool: "mitre_attack_search", expectedOutcome: "Relevant MITRE mapping and detection guidance for phishing scenarios.", timeAllocation: "5 minutes" }
    ],
    escalationCriteria: ["Multiple users clicked the phishing link or opened the attachment", "Credential harvesting confirmed (successful logins from attacker IPs)", "Malware execution confirmed on any endpoint", "Phishing targets senior executives or finance personnel (whaling)", "Phishing email originated from compromised internal account", "Attack appears to be part of a larger campaign targeting the organization"],
    containmentActions: ["Remove phishing email from all user inboxes via email purge", "Block sender domain and embedded URLs at email gateway and proxy", "Force password reset for all users who clicked the link or provided credentials", "Isolate endpoints where malware execution is confirmed", "Block attachment hashes in EDR/AV across environment", "Notify all recipients with security awareness guidance", "Submit phishing IOCs to threat intelligence sharing platforms"],
    investigationQuestions: ["How many users received the phishing email?", "How many users clicked the link or opened the attachment?", "What was the phishing objective (credential theft, malware delivery, fraud)?", "Is the phishing email part of a targeted campaign or mass phishing?", "Were any credentials successfully harvested?", "Is there evidence of account compromise following the phishing?", "What is the sender domain reputation and registration date?", "Are there similar phishing emails reported by other organizations?"]
  },
  {
    alertType: "data_exfiltration", title: "Data Exfiltration Triage Playbook", severity: "critical",
    mitreTechniques: ["T1048", "T1567", "T1020", "T1560", "T1005"],
    steps: [
      { order: 1, action: "Identify the source host, data volume, destination, and protocol used for exfiltration.", tool: "secops_ioc_enrich", expectedOutcome: "Source IP/hostname, data volume transferred, destination IP/domain, and protocol.", timeAllocation: "5 minutes" },
      { order: 2, action: "Enrich destination IP/domain with threat intelligence.", tool: "threat_intel_lookup", expectedOutcome: "Threat intelligence context for the exfiltration destination.", timeAllocation: "5 minutes" },
      { order: 3, action: "Check asset inventory for the source host.", tool: "secops_asset_inventory_lookup", expectedOutcome: "Asset ownership, criticality, data classification level, and business context.", timeAllocation: "5 minutes" },
      { order: 4, action: "Determine what data was accessed and exfiltrated.", tool: "log_analysis", expectedOutcome: "List of files accessed, databases queried, and data types exfiltrated.", timeAllocation: "15 minutes" },
      { order: 5, action: "Identify the user account associated with the exfiltration activity.", tool: "log_analysis", expectedOutcome: "User account, authentication method, and session timeline.", timeAllocation: "10 minutes" },
      { order: 6, action: "Check for data staging (archiving, compression) prior to exfiltration.", tool: "edr_forensics", expectedOutcome: "Evidence of data staging: archive creation, file collection, and compression tools.", timeAllocation: "10 minutes" },
      { order: 7, action: "Search for MITRE techniques related to exfiltration.", tool: "mitre_attack_search", expectedOutcome: "MITRE technique mapping with detection and response guidance.", timeAllocation: "5 minutes" }
    ],
    escalationCriteria: ["Exfiltration of PII, PHI, or PCI data (trigger data breach notification process)", "Exfiltration of intellectual property or trade secrets", "Large data volume (>1GB) transferred to external destination", "Exfiltration from critical systems (database servers, file servers, code repositories)", "Multiple hosts involved in exfiltration activity", "Exfiltration uses encrypted channels or unusual protocols"],
    containmentActions: ["Isolate source host from network immediately", "Block exfiltration destination IPs/domains at firewall/proxy", "Disable the user account associated with exfiltration", "Preserve forensic evidence (logs, network captures, disk images)", "Engage legal and compliance teams for data breach assessment", "Review and revoke any external access granted to affected accounts", "Initiate data breach notification procedures if regulated data is involved"],
    investigationQuestions: ["What type of data was exfiltrated (PII, IP, financial, credentials)?", "What is the volume of exfiltrated data?", "What protocol or channel was used for exfiltration?", "Is this an insider threat, compromised account, or external attacker?", "How long has the exfiltration been occurring?", "Was data staged or compressed before exfiltration?", "Are there regulatory reporting requirements for the exfiltrated data?", "Does the exfiltration destination match known threat actor infrastructure?"]
  },
  {
    alertType: "lateral_movement", title: "Lateral Movement Triage Playbook", severity: "high",
    mitreTechniques: ["T1021", "T1550", "T1210", "T1570", "T1563"],
    steps: [
      { order: 1, action: "Identify source host, target host, and lateral movement method.", tool: "secops_ioc_enrich", expectedOutcome: "Source host, target host(s), authentication method, and protocol used.", timeAllocation: "5 minutes" },
      { order: 2, action: "Check asset inventory for both source and target hosts.", tool: "secops_asset_inventory_lookup", expectedOutcome: "Asset criticality, ownership, and business context for all affected systems.", timeAllocation: "5 minutes" },
      { order: 3, action: "Trace the lateral movement path and identify the initial entry point.", tool: "log_analysis", expectedOutcome: "Full lateral movement chain, initial compromise host, and all affected systems.", timeAllocation: "20 minutes" },
      { order: 4, action: "Identify the user account and authentication material used for lateral movement.", tool: "log_analysis", expectedOutcome: "Account used, authentication method (password, hash, ticket, token), and privilege level.", timeAllocation: "10 minutes" },
      { order: 5, action: "Search for relevant MITRE techniques and detection rules.", tool: "mitre_attack_search", expectedOutcome: "MITRE technique mapping for the lateral movement method observed.", timeAllocation: "5 minutes" },
      { order: 6, action: "Check for persistence mechanisms and C2 on all affected hosts.", tool: "edr_forensics", expectedOutcome: "Persistence mechanisms, scheduled tasks, services, and active C2 channels.", timeAllocation: "15 minutes" }
    ],
    escalationCriteria: ["Lateral movement to domain controllers or critical infrastructure", "Multiple systems affected across different network segments", "Use of Pass-the-Hash or Pass-the-Ticket techniques", "Movement to systems containing sensitive data", "Lateral movement coinciding with defense evasion activities", "Evidence of privilege escalation prior to lateral movement"],
    containmentActions: ["Isolate all affected hosts from the network", "Disable compromised user accounts and reset credentials", "Reset KRBTGT password twice (if Pass-the-Ticket suspected)", "Block lateral movement protocols between affected network segments", "Review and revoke all sessions associated with compromised accounts", "Deploy EDR agents to all hosts in affected network segments"],
    investigationQuestions: ["What was the initial entry point for the attacker?", "What lateral movement techniques were used?", "How many systems were affected by the lateral movement?", "What credentials or authentication material was used?", "Is there evidence of privilege escalation?", "Were any persistence mechanisms deployed on target systems?", "What is the full scope of the compromise?", "Is there evidence of data collection or exfiltration from target systems?"]
  },
  {
    alertType: "privilege_escalation", title: "Privilege Escalation Triage Playbook", severity: "high",
    mitreTechniques: ["T1068", "T1055", "T1548", "T1134", "T1078"],
    steps: [
      { order: 1, action: "Identify the affected host, user account, and privilege escalation method.", tool: "secops_ioc_enrich", expectedOutcome: "Hostname, user account, initial privilege level, target privilege level, and method.", timeAllocation: "5 minutes" },
      { order: 2, action: "Check asset criticality and business context.", tool: "secops_asset_inventory_lookup", expectedOutcome: "Asset ownership, criticality, and whether privileged access is expected on this host.", timeAllocation: "5 minutes" },
      { order: 3, action: "Collect process tree and analyze the privilege escalation chain.", tool: "edr_forensics", expectedOutcome: "Full process ancestry, parent-child relationships, and token manipulation events.", timeAllocation: "15 minutes" },
      { order: 4, action: "Review account activity before and after privilege escalation.", tool: "log_analysis", expectedOutcome: "Timeline of account activity: initial access, escalation, and post-escalation actions.", timeAllocation: "15 minutes" },
      { order: 5, action: "Check for new account creation, group membership changes, and persistence.", tool: "log_analysis", expectedOutcome: "Any new local/domain accounts, group additions, and persistence mechanisms.", timeAllocation: "10 minutes" },
      { order: 6, action: "Search for relevant MITRE ATT&CK techniques.", tool: "mitre_attack_search", expectedOutcome: "MITRE technique mapping for the specific privilege escalation method observed.", timeAllocation: "5 minutes" }
    ],
    escalationCriteria: ["Privilege escalation to Domain Admin or Enterprise Admin", "Escalation on a domain controller or critical infrastructure server", "Creation of new privileged accounts", "Modification of domain trust relationships", "Evidence of credential dumping following escalation", "Multiple privilege escalation events across different systems"],
    containmentActions: ["Isolate affected host from network", "Disable the user account that performed the escalation", "Remove any unauthorized account creations or group memberships", "Review and audit all privileged group memberships", "Reset passwords for all accounts that were active on the affected host", "Deploy enhanced monitoring on all privileged accounts"],
    investigationQuestions: ["What privilege escalation technique was used?", "What was the initial privilege level of the compromised account?", "Was the escalation successful? What level was achieved?", "Is there evidence of exploitation (CVE) or credential-based escalation?", "Were any new accounts created or group memberships modified?", "What actions were taken after privilege escalation?", "Is this part of a larger attack chain (initial access -> escalation -> lateral movement)?", "Are there any persistence mechanisms deployed?"]
  }
];

// ============================================================
// Helper Functions
// ============================================================

export function lookupThreatIntel(indicator: string): ThreatIntelEntry | null {
  const normalized = indicator.trim().toLowerCase();
  return threatIntelKnowledgeBase.find(
    (entry) =>
      entry.value.toLowerCase() === normalized ||
      (normalized.length > 6 && entry.value.toLowerCase().includes(normalized)) ||
      (entry.value.length > 6 && normalized.includes(entry.value.toLowerCase()))
  ) ?? null;
}

export function searchMitreAttack(query: string): MitreAttackTechnique[] {
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  return mitreAttackTechniques
    .map((technique) => ({
      technique,
      score: terms.filter(
        (term) =>
          technique.id.toLowerCase().includes(term) ||
          technique.name.toLowerCase().includes(term) ||
          technique.tactic.toLowerCase().includes(term) ||
          technique.description.toLowerCase().includes(term) ||
          technique.platforms.some((p) => p.toLowerCase().includes(term)) ||
          technique.dataSources.some((ds) => ds.toLowerCase().includes(term))
      ).length
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((item) => item.technique);
}

export function getMitreTechniqueById(id: string): MitreAttackTechnique | null {
  return mitreAttackTechniques.find((t) => t.id.toUpperCase() === id.toUpperCase()) ?? null;
}

export function getTriagePlaybook(alertType: string): AlertTriagePlaybook | null {
  const normalized = alertType.trim().toLowerCase();
  return (
    alertTriagePlaybooks.find(
      (pb) =>
        pb.alertType === normalized ||
        pb.title.toLowerCase().includes(normalized) ||
        pb.mitreTechniques.some((t) => t.toLowerCase() === normalized)
    ) ?? null
  );
}

export function getMaliciousIpRisk(ip: string): { risk: "critical" | "high" | "medium" | "low"; reasons: string[] } {
  const reasons: string[] = [];
  let risk: "critical" | "high" | "medium" | "low" = "low";

  if (/^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip)) {
    return { risk: "low", reasons: ["Documentation/test IP range (RFC 5737). No actual threat."] };
  }
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip)) {
    return { risk: "low", reasons: ["Private/internal IP address. Context-dependent threat assessment needed."] };
  }
  const intel = lookupThreatIntel(ip);
  if (intel) {
    reasons.push(`Known malicious: ${intel.description}`);
    if (intel.severity === "critical") risk = "critical" as typeof risk;
    else if (intel.severity === "high" && (risk as string) !== "critical") risk = "high" as typeof risk;
    else if (intel.severity === "medium" && (risk as string) === "low") risk = "medium" as typeof risk;
  }
  return { risk, reasons };
}