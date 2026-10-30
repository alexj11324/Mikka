FROM node:24-bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server systemd systemd-sysv dbus-user-session sudo && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash mikka && echo 'mikka ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/mikka && mkdir -p /run/sshd && ssh-keygen -A && systemctl enable ssh && mkdir -p /home/mikka/.ssh && chmod 700 /home/mikka/.ssh && chown -R mikka:mikka /home/mikka/.ssh
RUN echo 'PasswordAuthentication no' >> /etc/ssh/sshd_config
ENV container=docker
CMD ["/sbin/init"]
