FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
COPY src src
RUN mvn -q -B -DskipTests package && cp target/canopy-backend-*.jar app.jar

FROM eclipse-temurin:21-jre
RUN useradd --system --create-home canopy
WORKDIR /home/canopy
USER canopy
COPY --from=build --chown=canopy /src/app.jar packed/app.jar
# Sized for a 512 MB host.
ENV JAVA_TOOL_OPTIONS="-XX:+UseSerialGC -XX:TieredStopAtLevel=1 -XX:MaxRAMPercentage=45 -XX:MaxMetaspaceSize=144m -XX:ReservedCodeCacheSize=48m -Xss512k"
# Unpack the jar and record a class archive: start-up on a tenth of a CPU takes minutes without it.
RUN java -Djarmode=tools -jar packed/app.jar extract --destination run \
 && cd run \
 && java -XX:ArchiveClassesAtExit=app.jsa -Dspring.context.exit=onRefresh -jar app.jar \
 && test -s app.jsa
# CANOPY_JWT_SECRET, CANOPY_CORS_ORIGINS, DB_URL, DB_USER and DB_PASSWORD come from the host.
ENV SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE=8 \
    SPRING_DATASOURCE_HIKARI_MINIMUM_IDLE=2
WORKDIR /home/canopy/run
EXPOSE 8090
# The default signing key is in the repository, so a public server must bring its own.
CMD ["sh", "-c", ": ${CANOPY_JWT_SECRET:?must be set}; exec java -XX:SharedArchiveFile=app.jsa -jar app.jar"]
