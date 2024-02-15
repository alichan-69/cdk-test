import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as codebuild from "aws-cdk-lib/aws-codebuild";

export class CdkTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPCを作成
    const testAPIVPC = new ec2.Vpc(this, "TestAPIVPC", {
      cidr: "10.0.0.0/23",
      maxAzs: 1,
      subnetConfiguration: [
        {
          cidrMask: 23,
          name: "PublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // VPC内で使用するセキュリティグループを作成
    const testAPISecurityGroup = new ec2.SecurityGroup(
      this,
      "TestAPISecurityGroup",
      {
        vpc: testAPIVPC,
        allowAllOutbound: true,
        securityGroupName: "TestAPISecurityGroup",
      }
    );

    testAPISecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.node.tryGetContext("env").myIPAddress),
      ec2.Port.tcp(80)
    );

    // ECRリポジトリを作成
    const testAPIECRRepository = new ecr.Repository(
      this,
      "TestAPIECRRepository",
      {
        repositoryName: "test-ecr-repository",
      }
    );

    // ECSクラスターを作成
    const testAPIECSCluster = new ecs.Cluster(this, "TestAPICluster", {
      vpc: testAPIVPC,
    });

    //タスクに付与するロールを作成
    const testAPITaskRole = new iam.Role(this, "TestAPITaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    testAPITaskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonECSTaskExecutionRolePolicy"
      )
    );

    // タスク定義を作成
    const testAPITask = new ecs.TaskDefinition(this, "TestAPITaskDefinition", {
      family: "test-api-family",
      compatibility: ecs.Compatibility.FARGATE,
      networkMode: ecs.NetworkMode.AWS_VPC,
      cpu: "1024",
      memoryMiB: "3072",
      executionRole: testAPITaskRole,
      taskRole: testAPITaskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
      },
    });

    const testAPIContainer = testAPITask.addContainer("test-api-task", {
      image: ecs.ContainerImage.fromEcrRepository(testAPIECRRepository),
      portMappings: [
        {
          name: "test-api-80-tcp",
          containerPort: 80,
          hostPort: 80,
          protocol: ecs.Protocol.TCP,
        },
      ],
      essential: true,
    });

    // サービスを作成してタスクをデプロイ
    const testAPIService = new ecs.FargateService(this, "TestAPIService", {
      cluster: testAPIECSCluster,
      taskDefinition: testAPITask,
      desiredCount: 0,
      securityGroups: [testAPISecurityGroup],
    });

    // CodePipelineを作成
    const testAPIPipeline = new codepipeline.Pipeline(this, "TestAPIPipeline", {
      pipelineName: "test-api-pipeline",
    });

    // CodePipelineのソースステージを追加
    const repository = new codecommit.Repository(this, "TestAPIRepository", {
      repositoryName: "test-api",
    });
    const sourceOutput = new codepipeline.Artifact();
    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: "Source",
      repository: repository,
      output: sourceOutput,
    });
    testAPIPipeline.addStage({
      stageName: "Source",
      actions: [sourceAction],
    });

    // CodePipelineのビルドステージを追加
    const buildRole = new iam.Role(this, "TestAPIBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    // CodeBuildに付与するRole追加
    buildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchCheckLayerAvailability",
        ],
        resources: ["*"],
      })
    );

    const buildProject = new codebuild.PipelineProject(this, "TestAPIBuild", {
      role: buildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              `aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin  [repositoryUriからリポジトリ名を削除した文字列]`,
              `REPOSITORY_URI=${testAPIECRRepository.repositoryUri}`,
              "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
              "IMAGE_TAG=${COMMIT_HASH:=latest}",
            ],
          },
          build: {
            commands: [
              "n install 16",
              "npm install",
              "npm test",
              "docker build -t $REPOSITORY_URI:latest .",
              "docker tag $REPOSITORY_URI:latest $REPOSITORY_URI:$IMAGE_TAG",
            ],
          },
          post_build: {
            commands: [
              "docker push $REPOSITORY_URI:latest",
              "docker push $REPOSITORY_URI:$IMAGE_TAG",
              `printf '[{"name":"next-container-task","imageUri":"%s"}]' $REPOSITORY_URI:latest > imagedefinitions.json`,
            ],
          },
        },
        artifacts: {
          files: ["imagedefinitions.json"],
        },
      }),
    });
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "Build",
      project: buildProject,
      input: sourceOutput,
    });
    testAPIPipeline.addStage({
      stageName: "Build",
      actions: [buildAction],
    });

    // CodePipelineのデプロイステージを追加
    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: "Deploy",
      service: testAPIService,
      input: sourceOutput,
    });
    testAPIPipeline.addStage({
      stageName: "Deploy",
      actions: [deployAction],
    });
  }
}

const app = new cdk.App();
new CdkTestStack(app, "CdkTestStack");
app.synth();
