FROM centos:7
MAINTAINER Jason Ish <ish@unx.ca>

# RUN rpm -Uvh https://evebox.org/files/rpm/development/evebox-development-release.noarch.rpm && \
#     yum install --disablerepo=* --enablerepo=evebox-development -y evebox && \
#     /usr/bin/evebox version

RUN rpm -Uvh http://evebox-ci.satie.io.s3.amazonaws.com/master/evebox-latest-x86_64.rpm && \
    yum install -y evebox && \
    /usr/bin/evebox version

EXPOSE 5636

COPY /docker-entrypoint.sh /

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["evebox", "server"]
